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
    { clave: "periodo",       rotulo: "Período del calendario",
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
             "se toma el valor del último período" },
    // ── aperturas: por dónde se abre el detalle ─────────────────────
    // Ninguna es obligatoria. Cada una que esté mapeada agrega una solapa de
    // «ver datos» y una vista más en el tablero interactivo, así que un modelo
    // rico se ve rico sin tocar código.
    { clave: "clienteRazon",     rotulo: "Razón social del cliente",
      ayuda: "El nombre legal, si es distinto del nombre de fantasía" },
    { clave: "claseDocumento",   rotulo: "Clase de documento" },
    { clave: "tipoDeuda",        rotulo: "Tipo de deuda" },
    { clave: "condicionPago",    rotulo: "Condición de pago" },
    { clave: "estadoVencimiento",rotulo: "Estado de vencimiento" },
    { clave: "moneda",           rotulo: "Moneda del documento" },
    { clave: "concepto",         rotulo: "Concepto (facturación)",
      ayuda: "De la tabla de provisión: por qué está pendiente de facturar" },
    { clave: "tipoProvision",    rotulo: "Tipo (facturación)" },
    { clave: "statusPendiente",  rotulo: "Estado de la facturación" },
    { clave: "tramoFacturacion", rotulo: "Tramo de antigüedad (facturación)",
      ayuda: "El aging de lo no facturado, que suele ser otra columna que el de cobranza" },
    // ── identificadores, para las exclusiones del tablero ───────────
    { clave: "textoCabecera",  rotulo: "Texto de cabecera del documento",
      ayuda: "Donde el tablero busca la marca de orden de pago (OP)" },
    { clave: "clienteNumero",  rotulo: "Número de cliente" },
    { clave: "documentoId",    rotulo: "Número de documento",
      ayuda: "Para excluir un documento puntual" },
    { clave: "documentoId2",   rotulo: "Número de documento (alterno)",
      ayuda: "Si el ID puede estar en dos columnas, la segunda va acá" },
    // ── apertura mensual de la provisión ───────────────────────────
    { clave: "anioProvision",  rotulo: "Año de la provisión" },
    { clave: "mesProvision",   rotulo: "Mes de la provisión",
      ayuda: "El número de mes, para abrir el pendiente de facturar mes por mes" },
    // ── observaciones por cliente ──────────────────────────────────
    { clave: "obsCliente",     rotulo: "Cliente de las observaciones",
      ayuda: "En la hoja de observaciones: la columna con el nombre del cliente" },
    { clave: "obsTexto",       rotulo: "Texto de la observación" }
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
    clienteKam: "Cliente[KAM]", canal: "", riesgo: "", dsoPeriodo: "",
    clienteRazon: "", claseDocumento: "", tipoDeuda: "", condicionPago: "",
    estadoVencimiento: "", moneda: "", concepto: "", tipoProvision: "",
    statusPendiente: "", tramoFacturacion: "",
    textoCabecera: "", clienteNumero: "", documentoId: "", documentoId2: "",
    anioProvision: "", mesProvision: "", obsCliente: "", obsTexto: ""
  },
  periodoFormato: "numero",
  organizacion: "",
  workspaceId: "",
  datasetId: "",
  // Referencias que el modelo semántico rechazó. Se llenan solas, al verificar
  // o cuando un informe falla, y valen tanto como un campo sin mapear: la
  // diferencia es que acá se conserva el texto para poder corregirlo.
  rotos: [],
  // Con qué valor arranca cada segmentador. Un tablero suele mirar una sola
  // sociedad aunque el modelo tenga varias: sin esto, el informe sale con
  // datos de sociedades que nadie pidió.
  filtrosPorDefecto: {},
  // Lo que el tablero recorta SIEMPRE y nadie puede cambiar: el canal, las
  // clases de documento que cuentan. Replicarlo es lo que hace que el informe
  // dé los mismos números que la pantalla de Power BI.
  exclusiones: []
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
    rotos: [],
    filtrosPorDefecto: {},
    exclusiones: []
  };
  for (const c of CAMPOS.medidas) {
    salida.medidas[c.clave] = validarRef((e.medidas || {})[c.clave], "medida");
  }
  for (const c of CAMPOS.columnas) {
    salida.columnas[c.clave] = validarRef((e.columnas || {})[c.clave], "columna");
  }
  /* Nada es imprescindible acá. Qué hace falta lo decide cada informe, que
     para eso declara lo que usa; el mapeo sólo dice qué hay.

     El período era la excepción —«es lo que ordena cualquier serie»— y estaba
     mal: un tablero de cartera es una foto a la fecha y puede no tener tabla
     de calendario. Exigirlo hacía que un modelo perfectamente usable se
     rechazara entero y el informe cayera al mapeo de ejemplo sin avisar. */
  // sólo identificadores conocidos, y sólo de campos que tienen algo escrito
  // sólo dimensiones conocidas, y el valor como texto llano
  for (const [clave, valor] of Object.entries(e.filtrosPorDefecto || {})) {
    if (!salida.columnas[clave] || valor == null) continue;
    const v = String(valor).trim().slice(0, 120);
    if (v) salida.filtrosPorDefecto[clave] = v;
  }
  // Cada regla apunta a una columna mapeada y trae UNA de las cuatro formas.
  for (const r of Array.isArray(e.exclusiones) ? e.exclusiones : []) {
    const campo = String((r || {}).campo || "");
    if (campo && !salida.columnas[campo]) continue;
    const lista = (xs) => (Array.isArray(xs) ? xs : [])
      .map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 60);
    const regla = { campo };
    // La regla de la orden de pago es condicional, no un filtro suelto: una
    // clase de documento la EXIGE y las demás la prohíben. Se declara con
    // nombre propio en vez de dejar escribir DAX en un archivo de config.
    if (r.tipo === "ordenDePago") {
      if (!salida.columnas[r.texto] || !r.marca || !r.claseConMarca) continue;
      salida.exclusiones.push({ tipo: "ordenDePago", campo,
        texto: String(r.texto), marca: String(r.marca).slice(0, 40),
        claseConMarca: String(r.claseConMarca).slice(0, 40) });
      continue;
    }
    // un mismo id puede vivir en dos columnas: se excluye si coincide en alguna
    if (Array.isArray(r.campos)) {
      const cols = r.campos.map(String).filter((k) => salida.columnas[k]);
      if (!cols.length || !r.excluir) continue;
      salida.exclusiones.push({ campos: cols,
        excluir: (Array.isArray(r.excluir) ? r.excluir : [r.excluir])
          .map((x) => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 60) });
      continue;
    }
    if (r.igual != null && String(r.igual).trim()) regla.igual = String(r.igual).trim().slice(0, 120);
    else if (r.contiene) regla.contiene = String(r.contiene).trim().slice(0, 120);
    else if (lista(r.incluir).length) regla.incluir = lista(r.incluir);
    else if (lista(r.excluir).length) regla.excluir = lista(r.excluir);
    else continue;
    salida.exclusiones.push(regla);
  }
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
  if (!entrada || !entrada.filtrosPorDefecto) m.filtrosPorDefecto = previo.filtrosPorDefecto;
  if (!entrada || !entrada.exclusiones) m.exclusiones = previo.exclusiones;
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
