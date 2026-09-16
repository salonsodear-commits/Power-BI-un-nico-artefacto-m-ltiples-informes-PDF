"use strict";
/**
 * Mapeo entre los campos lógicos de los informes y los nombres reales del
 * modelo semántico.
 *
 * Es la pieza que hace que el generador sirva para CUALQUIER tablero: los
 * informes piden "real" o "vertical", y acá se traduce a `[Facturación Neta]`
 * o `Dim_Vertical[Descripcion]`, que es como se llaman en tu modelo.
 *
 * Se edita desde el artefacto (Conectar → Mapeo) y se guarda en modelo.json.
 */
const fs = require("fs");
const path = require("path");

const ARCHIVO = path.join(__dirname, "modelo.json");
// La semilla sí va al repositorio; el archivo en uso no, para que guardar el
// mapeo nunca choque con un git pull.
const SEMILLA = path.join(__dirname, "modelo.ejemplo.json");

/** Campos que los informes saben usar. `req` marca los imprescindibles. */
const CAMPOS = {
  medidas: [
    { clave: "real",              rotulo: "Real / Facturación" },
    { clave: "bo",                rotulo: "BO / Objetivo" },
    { clave: "variacion",         rotulo: "Variación (Real − BO)" },
    { clave: "variacionPct",      rotulo: "Variación %" },
    { clave: "ebitda",            rotulo: "EBITDA" },
    { clave: "margenEbitda",      rotulo: "Margen EBITDA %" },
    { clave: "opex",              rotulo: "OPEX" },
    { clave: "opexBo",            rotulo: "OPEX objetivo" },
    { clave: "provisiones",       rotulo: "Provisiones" },
    { clave: "pendienteFacturar", rotulo: "Pendiente de facturar" },
    { clave: "dso",               rotulo: "DSO",
      ayuda: "Si no es una medida, vale una agregación: MIN(DSO[DSO - CORP])" },
    { clave: "saldoCxC",          rotulo: "Saldo cuentas por cobrar" },
    { clave: "facturacion",       rotulo: "Facturación por cliente" },
    { clave: "costos",            rotulo: "Costos" },
    { clave: "margen",            rotulo: "Margen" },
    { clave: "margenPct",         rotulo: "Margen %" },
    { clave: "clientesActivos",   rotulo: "Clientes activos" },
    // ── cartera de deuda y cobranzas ────────────────────────────────
    { clave: "deudaTotal",        rotulo: "Deuda total" },
    { clave: "deudaVencida",      rotulo: "Deuda vencida" },
    { clave: "deudaNoVencida",    rotulo: "Deuda no vencida" },
    { clave: "deudaFacturacion",  rotulo: "Deuda de facturación" },
    { clave: "deudaCobranza",     rotulo: "Deuda de cobranza" },
    { clave: "importeFacturado",  rotulo: "Importe facturado" },
    { clave: "indiceRiesgo",      rotulo: "Índice de riesgo" }
  ],
  columnas: [
    { clave: "periodo",       rotulo: "Período del calendario", req: true,
      ayuda: "Una columna a nivel MES: el número 202607 o el texto 2026-07. " +
             "Una columna de fecha no sirve, porque DAX no agrupa por expresiones." },
    { clave: "sociedad",      rotulo: "Sociedad" },
    { clave: "vertical",      rotulo: "Vertical / unidad de negocio" },
    { clave: "gastoCategoria",rotulo: "Categoría de gasto (OPEX)" },
    { clave: "agingTramo",    rotulo: "Tramo de aging" },
    { clave: "clienteNombre", rotulo: "Cliente" },
    { clave: "clienteKam",    rotulo: "KAM responsable" },
    { clave: "canal",         rotulo: "Canal / segmento" },
    { clave: "riesgo",        rotulo: "Semáforo de riesgo" },
    { clave: "dsoPeriodo",    rotulo: "Período de la tabla de DSO",
      ayuda: "Sólo si el DSO vive en su propia tabla sin relación con el calendario: " +
             "se toma el valor del último período" }
  ]
};

/** Modelo de ejemplo del manual: sirve de plantilla, no de verdad. */
const POR_DEFECTO = {
  medidas: {
    real: "[Real]", bo: "[BO]", variacion: "[Variación]", variacionPct: "[Variación %]",
    ebitda: "[EBITDA]", margenEbitda: "[Margen EBITDA %]",
    opex: "[OPEX]", opexBo: "[OPEX BO]", provisiones: "[Provisiones]",
    pendienteFacturar: "[Pendiente de facturar]", dso: "[DSO]", saldoCxC: "[Saldo CxC]",
    facturacion: "[Facturación]", costos: "[Costos]", margen: "[Margen]",
    margenPct: "[Margen %]", clientesActivos: "[Clientes activos]",
    deudaTotal: "", deudaVencida: "", deudaNoVencida: "", deudaFacturacion: "",
    deudaCobranza: "", importeFacturado: "", indiceRiesgo: ""
  },
  columnas: {
    periodo: "Calendario[ClaveMes]", sociedad: "Sociedad[Nombre]",
    vertical: "Vertical[Nombre]", gastoCategoria: "Gastos[Categoria]",
    agingTramo: "Aging[Tramo]", clienteNombre: "Cliente[Nombre]",
    clienteKam: "Cliente[KAM]", canal: "", riesgo: "", dsoPeriodo: ""
  },
  periodoFormato: "numero",
  organizacion: "",
  workspaceId: "",
  datasetId: "",
  // Referencias que el modelo semántico rechazó. Se llenan solas, al verificar
  // o cuando un informe falla, y valen tanto como un campo sin mapear: la
  // diferencia es que acá se conserva el texto para poder corregirlo.
  rotos: []
};

/* ── validación ──────────────────────────────────────────────────────
   Todo lo que se escribe acá termina interpolado en una consulta DAX, así
   que sólo se aceptan referencias con la forma exacta `[Medida]` o
   `Tabla[Columna]`. Nada de paréntesis, comas ni comillas. */
const REF_MEDIDA = /^\[[^\[\]"']{1,100}\]$/;
const COL = "(?:'[^'\\r\\n]{1,100}'|[A-Za-zÀ-ÿ_][\\wÀ-ÿ .-]{0,99})\\[[^\\[\\]\"']{1,100}\\]";
const REF_COLUMNA = new RegExp("^" + COL + "$");
/**
 * No todo modelo expone medidas: a veces el dato es una columna y hay que
 * agregarla. Se admite una función de agregación sobre una columna, con la
 * lista de funciones cerrada para que nada más entre en la consulta.
 */
const FUNCIONES = "SUM|MIN|MAX|AVERAGE|COUNT|DISTINCTCOUNT|COUNTROWS";
const REF_AGREGADA = new RegExp("^(?:" + FUNCIONES + ")\\(\\s*" + COL + "\\s*\\)$", "i");

function validarRef(valor, tipo) {
  const s = String(valor || "").trim();
  if (!s) return "";
  const ok = tipo === "medida"
    ? (REF_MEDIDA.test(s) || REF_AGREGADA.test(s))
    : REF_COLUMNA.test(s);
  if (!ok) {
    throw new Error(
      tipo === "medida"
        ? `"${s}" no es válida. Se espera [Nombre de la medida], o una agregación ` +
          `sobre una columna: SUM(Tabla[Columna]), MIN(...), MAX(...), AVERAGE(...), ` +
          `COUNT(...), DISTINCTCOUNT(...).`
        : `"${s}" no es una columna válida. Se espera Tabla[Columna] o 'Mi Tabla'[Columna].`
    );
  }
  return s;
}

/** `Ventas[Monto]` → `Ventas` · `'Mi Tabla'[X]` → `'Mi Tabla'` */
function tablaDe(ref) {
  const i = String(ref).indexOf("[");
  return i > 0 ? ref.slice(0, i) : "";
}

function normalizar(entrada) {
  const e = entrada && typeof entrada === "object" ? entrada : {};
  const salida = {
    medidas: {}, columnas: {},
    // "numero" → 202607 · "texto" → "2026-07"
    periodoFormato: e.periodoFormato === "texto" ? "texto" : "numero",
    organizacion: String(e.organizacion || "").slice(0, 80),
    workspaceId: String(e.workspaceId || "").trim(),
    datasetId: String(e.datasetId || "").trim(),
    rotos: []
  };
  for (const c of CAMPOS.medidas) {
    salida.medidas[c.clave] = validarRef((e.medidas || {})[c.clave], "medida");
  }
  for (const c of CAMPOS.columnas) {
    salida.columnas[c.clave] = validarRef((e.columnas || {})[c.clave], "columna");
  }
  // Sólo el período es imprescindible: es lo que ordena cualquier serie.
  // Qué medidas hacen falta lo decide cada informe, no el mapeo.
  const faltan = [...CAMPOS.medidas, ...CAMPOS.columnas]
    .filter((c) => c.req)
    .filter((c) => !(salida.medidas[c.clave] || salida.columnas[c.clave]))
    .map((c) => c.rotulo);
  if (faltan.length) throw new Error("Falta mapear: " + faltan.join(", "));
  // sólo identificadores conocidos, y sólo de campos que tienen algo escrito
  salida.rotos = (Array.isArray(e.rotos) ? e.rotos : [])
    .map(String)
    .filter((id) => VALIDOS.has(id))
    .filter((id) => { const [g, c] = id.split("."); return !!salida[g][c]; });
  return salida;
}

/** "medidas.bo", "columnas.periodo"… los identificadores que `rotos` acepta. */
const VALIDOS = new Set([
  ...CAMPOS.medidas.map((c) => "medidas." + c.clave),
  ...CAMPOS.columnas.map((c) => "columnas." + c.clave)
]);

let cache = null;
let origen = null;   // de dónde salió lo que está en memoria

function leer() {
  if (cache) return cache;
  for (const [ruta, de] of [[ARCHIVO, "modelo.json"], [SEMILLA, "modelo.ejemplo.json"]]) {
    try {
      cache = normalizar(JSON.parse(fs.readFileSync(ruta, "utf8")));
      origen = de;
      return cache;
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[modelo] " + de + " ignorado:", e.message);
    }
  }
  cache = normalizar(POR_DEFECTO);
  origen = "plantilla interna";
  return cache;
}

/** Para el arranque: qué mapeo se está usando y cuánto tiene puesto. */
function resumen() {
  const m = leer();
  const cuenta = (o) => Object.values(o).filter(Boolean).length;
  return { origen, medidas: cuenta(m.medidas), columnas: cuenta(m.columnas) };
}

function guardar(entrada) {
  const previo = leer();
  const m = normalizar(entrada);
  // Reescribir un campo es decir "ahora sí": el que cambió deja de estar roto.
  const heredados = (entrada && Array.isArray(entrada.rotos) ? entrada.rotos : previo.rotos)
    .filter((id) => { const [g, c] = String(id).split("."); return previo[g] && previo[g][c] === m[g][c]; });
  m.rotos = normalizar({ ...m, rotos: heredados }).rotos;
  escribir(m);
  return m;
}

function escribir(m) {
  fs.writeFileSync(ARCHIVO, JSON.stringify(m, null, 2) + "\n");
  cache = m;
  origen = "modelo.json";
}

/**
 * Anota qué referencias contestó mal el modelo semántico. Lo llaman la
 * verificación y el informe que falla, para que la próxima vez el catálogo ya
 * sepa que ese campo no sirve en vez de volver a ofrecer un informe imposible.
 */
function marcar(cambios) {
  const m = { ...leer() };
  const set = new Set(m.rotos);
  let cambio = false;
  for (const [id, roto] of Object.entries(cambios || {})) {
    if (!VALIDOS.has(id)) continue;
    const antes = set.size;
    roto ? set.add(id) : set.delete(id);
    if (set.size !== antes) cambio = true;
  }
  if (!cambio) return m;
  escribir(normalizar({ ...m, rotos: [...set] }));
  return cache;
}

/** ¿Este campo existe de verdad en el modelo? (mapeado y no marcado roto) */
function sirve(grupo, clave) {
  const m = leer();
  return !!m[grupo][clave] && !m.rotos.includes(grupo + "." + clave);
}

/** Borra el mapeo local y vuelve a la semilla del repositorio. */
function reiniciar() {
  try { fs.unlinkSync(ARCHIVO); } catch (e) { if (e.code !== "ENOENT") throw e; }
  cache = null; origen = null;
  return leer();
}

/**
 * ¿Puede un informe usar este campo? Los informes saltean lo que no lo está.
 * Un campo marcado roto cuenta como ausente: es preferible un informe con una
 * sección menos que una consulta que falla entera.
 */
const tiene = (grupo, clave) => sirve(grupo, clave);

module.exports = { CAMPOS, POR_DEFECTO, leer, guardar, normalizar, tablaDe, tiene,
                   sirve, marcar, resumen, reiniciar, ARCHIVO, SEMILLA };
