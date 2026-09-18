"use strict";
/**
 * Qué segmentadores tiene este tablero, y cuáles sirven de verdad.
 *
 * No alcanza con que la columna exista. En un modelo con varias tablas de
 * hechos, un segmentador puesto sobre la tabla equivocada filtra la mitad de
 * los números y no avisa: las relaciones suelen ser unidireccionales, así que
 * una columna del aging filtra la cobranza pero deja la facturación intacta.
 * Un panel con un control que hace la mitad de lo que dice es peor que sin
 * control, porque el número igual sale y parece bien.
 *
 * Por eso cada candidato se PRUEBA: se lo abre por sus valores pidiendo las
 * medidas clave, y se mira si de verdad las reparte. Sólo pasan los que sí.
 *
 * De paso, la misma consulta dice si el tablero ya viene recortado —una sola
 * sociedad, un solo canal— para mostrarlo como contexto en vez de pedirlo.
 */
const { consultar } = require("./client");
const MODELO = require("../modelo");
const Q = require("./queries");

/** Las que tiene sentido ofrecer, en el orden en que se muestran. */
const DIMENSIONES = [
  { clave: "sociedad", rotulo: "Sociedad" },
  { clave: "canal",    rotulo: "Canal" },
  { clave: "vertical", rotulo: "Negocio" },
  { clave: "clienteKam", rotulo: "Gestor" },
  { clave: "riesgo",   rotulo: "Riesgo" },
  { clave: "moneda",   rotulo: "Moneda" }
];

const rotuloDe = (clave) => (DIMENSIONES.find((d) => d.clave === clave) || {}).rotulo ||
  ({ claseDocumento: "Clase de documento", tipoDeuda: "Tipo de deuda",
     condicionPago: "Condición de pago", estadoVencimiento: "Estado de vencimiento",
     concepto: "Concepto", agingTramo: "Tramo de aging", clienteNumero: "Cliente",
     documentoId: "Documento", documentoId2: "Documento", clienteNombre: "Cliente",
     textoCabecera: "Texto de cabecera" }[clave] || clave);

const TOPE = 40;          // valores por dimensión; más no entra en un desplegable
const CERCA = 0.005;      // 0,5 % de holgura al comparar totales

/**
 * @param medidas claves lógicas que el segmentador tiene que saber repartir.
 *   Son las del informe: si una no se mueve, el control miente sobre ella.
 */
async function contexto(workspaceId, datasetId, medidas) {
  const m = MODELO.leer();
  const usables = (medidas || []).filter((k) => Q.m(k));
  if (!usables.length) return { dimensiones: [], fijos: [], elegibles: [], medidas: [] };

  // el total contra el que se compara cada apertura
  const fila = Q.filaMedidas(usables);
  const totales = (await consultar(workspaceId, datasetId,
    `\nEVALUATE\n  ROW(\n${fila}\n  )`))[0] || {};

  const salida = [];
  let sinSesion = false;

  // Los meses que el calendario tiene de verdad: el panel ofrece ésos y no un
  // campo libre donde se puede tipear un mes que el modelo no conoce.
  let periodos = [];
  if (m.columnas.periodo) {
    try {
      const filas = await consultar(workspaceId, datasetId, Q.valoresDe(m.columnas.periodo, 400));
      periodos = [...new Set(filas
        .map((f) => normalizarMes(Object.values(f)[0]))
        .filter(Boolean))].sort().reverse();
    } catch (e) { console.warn("[contexto] períodos: " + e.message); }
  }

  await Promise.all(DIMENSIONES.map(async (d) => {
    const col = m.columnas[d.clave];
    if (!col || (m.rotos || []).includes("columnas." + d.clave)) return;
    let filas;
    try {
      filas = await consultar(workspaceId, datasetId,
        Q.desglose({ por: col, medidas: usables, tope: TOPE }));
    } catch (e) {
      if (e.necesitaIngreso) { sinSesion = true; return; }
      console.warn("[contexto] " + d.clave + ": " + e.message);
      return;
    }

    const valores = valoresUnicos(filas);
    if (!valores.length) return;

    /* ¿La medida se MUEVE al abrir por esta dimensión?
       Ésa es la pregunta, y no «¿la suma de las partes da el total?». Lo
       segundo suena más exigente pero se rompe solo: el TOPN recorta, una
       medida como el DSO no es aditiva, y los blancos no se listan. Lo que
       delata a un segmentador que no propaga es que devuelva EL MISMO valor
       en cada rebanada — el total entero, una y otra vez. */
    const reparte = {}, rotas = [];
    for (const k of usables) {
      const vs = filas.map((f) => f[k]).filter((v) => typeof v === "number");
      const total = totales[k];
      if (typeof total !== "number" || total === 0) { reparte[k] = null; continue; }
      if (!vs.length) { reparte[k] = false; rotas.push(k); continue; }   // la apaga
      if (valoresUnicos(filas).length < 2) { reparte[k] = null; continue; }  // nada que probar
      const inmovil = vs.every((v) => Math.abs(v - total) <= Math.abs(total) * CERCA);
      reparte[k] = !inmovil;
      if (inmovil) rotas.push(k);
    }

    // Con un solo valor no hay nada que elegir ni nada que probar: es contexto.
    const fijo = valores.length === 1;
    /* Un segmentador que mueve una medida y no la otra NO se descarta: se
       rotula. «Gestor — sólo cobranza» es un control honesto y útil; el
       pecado era mostrarlo como si filtrara todo. Se descarta sólo el que no
       mueve NADA, que ahí sí no hace nada. */
    const alcance = usables.filter((k) => reparte[k] !== false);
    const sirve = fijo || alcance.length > 0;

    salida.push({
      clave: d.clave, rotulo: d.rotulo, ref: col,
      valores: valores.sort((a, b) => a.localeCompare(b, "es")),
      fijo, sirve, rotas, alcance,
      // qué medidas NO mueve, que es lo que hay que aclarar en el rótulo
      parcial: !fijo && rotas.length > 0 && alcance.length > 0,
      porDefecto: m.filtrosPorDefecto[d.clave] || null,
      truncado: filas.length >= TOPE
    });
  }));

  if (sinSesion) { const e = new Error("No hay sesión iniciada"); e.necesitaIngreso = true; throw e; }

  const orden = DIMENSIONES.map((d) => d.clave);
  salida.sort((a, b) => orden.indexOf(a.clave) - orden.indexOf(b.clave));
  for (const d of salida.filter((x) => !x.fijo && !x.sirve)) {
    console.warn("[contexto] " + d.clave + " no se ofrece: no mueve ninguna medida (" + d.ref + ")");
  }
  for (const d of salida.filter((x) => x.parcial)) {
    console.log("[contexto] " + d.clave + " se ofrece acotado: mueve " + d.alcance.join(", ") +
                " pero no " + d.rotas.join(", "));
  }
  return {
    dimensiones: salida,
    medidas: usables,
    nombresMedida: NOMBRE_MEDIDA,
    periodos,
    // las exclusiones fijas del tablero, ya legibles
    exclusiones: (m.exclusiones || []).map((r) => Q.textoExclusion(r,
      rotuloDe(r.campo || (r.campos || [])[0]))),
    tieneAging: !!m.columnas.agingTramo,
    // lo que el tablero ya trae recortado: se informa, no se pide
    fijos: salida.filter((x) => x.fijo)
                 .map((x) => ({ clave: x.clave, rotulo: x.rotulo, valor: x.valores[0] })),
    // y lo que se puede elegir, ya probado
    elegibles: salida.filter((x) => !x.fijo && x.sirve)
  };
}

/**
 * Un valor de la columna de período llevado a «AAAA-MM».
 *
 * Cada modelo la guarda distinto: el entero 202607, el texto «2026-07» o una
 * fecha completa. Las tres tienen que terminar en lo mismo, o el selector de
 * meses ofrece cosas que la consulta después no reconoce.
 */
function normalizarMes(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-?(0[1-9]|1[0-2])$/);        // 202607 · 2026-07
  if (m) return m[1] + "-" + m[2];
  m = s.match(/^(\d{4})-(\d{2})-\d{2}/);                // 2026-07-01T00:00:00
  if (m) return m[1] + "-" + m[2];
  // sólo formas con el año primero: «1/7/2026» es ambiguo y adivinar mal
  // llenaría el selector de meses que no existen
  return null;
}

/** Los valores de la primera columna —la dimensión— sin repetir ni vacíos. */
const valoresUnicos = (filas) => [...new Set(filas
  .map((f) => Object.values(f)[0])
  .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
  .map(String))];

/** Cómo se nombra cada medida en un rótulo de segmentador. */
const NOMBRE_MEDIDA = {
  deudaCobranza: "cobranza", deudaFacturacion: "facturación",
  deudaVencida: "vencida", deudaTotal: "exposición",
  importeFacturado: "facturado", clientesActivos: "clientes"
};

module.exports = { contexto, DIMENSIONES, NOMBRE_MEDIDA };
