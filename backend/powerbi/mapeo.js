"use strict";
/**
 * Deduce el mapeo a partir del inventario del modelo.
 *
 * La diferencia con adivinar nombres: acá no se prueba si existe una tabla
 * llamada «Calendario» —ni «Dim_Fecha», ni «DimDate»—; se mira la lista real
 * de tablas y columnas que devolvió el modelo y se decide sobre ella. Un
 * tablero cuyas tablas se llamen de cualquier otra forma funciona igual,
 * que es justamente lo que no pasaba antes.
 *
 * Cada papel —el cliente, el tramo de aging, el período— se resuelve como una
 * búsqueda con puntaje sobre TODAS las columnas del modelo a la vez:
 *
 *   · el nombre, que es donde vive el significado de negocio;
 *   · el tipo y la cantidad de valores distintos, que descartan imposibles
 *     (un cliente no es una columna de dos valores, un tramo no tiene 4.000);
 *   · y la tabla, que desempata: si el cliente ya cayó en tal tabla, su razón
 *     social y su gestor probablemente estén ahí también.
 *
 * Lo que el Power Query ya dejó filtrado se reconoce solo: una columna con un
 * único valor distinto en todo el modelo no es un segmentador, es un dato de
 * contexto, y el panel la muestra como tal en vez de ofrecer un desplegable
 * con una sola opción.
 */

/* ── los papeles ──────────────────────────────────────────────────────────
   `patrones` va de más específico a menos: el primero que calza puntúa más.
   `tipo` y los topes de cardinalidad son filtros duros: sirven para que un
   número no se cuele como dimensión ni una clave como categoría. */
const PAPELES = {
  periodo:      { patrones: [/^per[ií]odo$/i, /a[ñn]o[\s_-]*mes/i, /year[\s_-]*month/i,
                             /^yyyymm$/i, /clave[\s_]*mes/i, /month[\s_-]*key/i,
                             /^per[ií]odo/i, /^fecha$/i, /^date$/i],
                  mes: true, cardMin: 2, prefiereCalendario: true },
  clienteNombre:{ patrones: [/cliente\s*fantas/i, /nombre\s*fantas/i, /^cliente$/i,
                             /^customer(\s*name)?$/i, /^cuenta$/i, /^account$/i,
                             /cliente.*nombre/i, /nombre.*cliente/i],
                  tipo: "texto", cardMin: 2, cardMax: 20000 },
  clienteRazon: { patrones: [/raz[oó]n\s*social/i, /^cliente$/i, /legal\s*name/i,
                             /nombre\s*legal/i],
                  tipo: "texto", cardMin: 2, cardMax: 20000, distintoDe: "clienteNombre" },
  clienteKam:   { patrones: [/gestor.*cobranz/i, /^gestor$/i, /^kam$/i, /account\s*manager/i,
                             /propietario.*cuenta/i, /responsable/i, /ejecutiv/i, /vendedor/i],
                  tipo: "texto", cardMin: 2, cardMax: 500 },
  clienteNumero:{ patrones: [/n[uú]mero\s*cliente/i, /^n[°º]?\s*cliente$/i, /cliente.*n[uú]m/i,
                             /customer\s*(id|number)/i, /cod.*cliente/i],
                  cardMin: 2 },
  sociedad:     { patrones: [/sociedad[_\s]*name/i, /^sociedad$/i, /^compa[ñn][ií]a$/i,
                             /^empresa$/i, /^company$/i, /^entidad$/i, /legal\s*entity/i],
                  tipo: "texto", cardMax: 200 },
  canal:        { patrones: [/canal.*distribuci/i, /^canal$/i, /^channel$/i],
                  tipo: "texto", cardMax: 200 },
  vertical:     { patrones: [/^negocio$/i, /^vertical$/i, /unidad.*negocio/i, /^segmento$/i,
                             /business\s*unit/i, /^divisi[oó]n$/i, /^[aá]rea$/i],
                  tipo: "texto", cardMax: 200 },
  agingTramo:   { patrones: [/rango.*d[ií]as.*venc/i, /rango.*venc/i, /^tramo$/i,
                             /tramo.*venc/i, /aging/i, /^bucket$/i, /d[ií]as.*venc/i],
                  tipo: "texto", cardMin: 2, cardMax: 40 },
  tramoFacturacion:{ patrones: [/tramo[_\s]*antig/i, /antig[üu]edad/i, /^tramo$/i, /^bucket$/i],
                  tipo: "texto", cardMin: 2, cardMax: 40, distintoDe: "agingTramo" },
  estadoVencimiento:{ patrones: [/estado.*vencim/i, /^vencido$/i, /^estado$/i, /due\s*status/i],
                  tipo: "texto", cardMin: 2, cardMax: 20 },
  riesgo:       { patrones: [/sem[áa]foro/i, /^riesgo$/i, /indicador.*riesgo/i, /^risk$/i],
                  tipo: "texto", cardMin: 2, cardMax: 20 },
  claseDocumento:{ patrones: [/clase.*documento/i, /^clase$/i, /document.*type/i, /^tipo\s*doc/i],
                  tipo: "texto", cardMin: 2, cardMax: 200 },
  tipoDeuda:    { patrones: [/tipo.*deuda/i, /debt.*type/i],
                  tipo: "texto", cardMin: 2, cardMax: 50 },
  condicionPago:{ patrones: [/condici[oó]n.*pago/i, /payment.*term/i, /^plazo$/i],
                  tipo: "texto", cardMin: 2, cardMax: 100 },
  moneda:       { patrones: [/^moneda/i, /moneda.*documento/i, /^currency$/i, /^divisa$/i],
                  tipo: "texto", cardMax: 50 },
  concepto:     { patrones: [/^concepto$/i, /^servicio$/i, /^rubro$/i, /^categor[ií]a$/i,
                             /^item$/i, /^producto$/i],
                  tipo: "texto", cardMin: 2, cardMax: 2000 },
  tipoProvision:{ patrones: [/^tipo$/i, /^type$/i, /tipo.*provis/i],
                  tipo: "texto", cardMin: 2, cardMax: 50 },
  statusPendiente:{ patrones: [/status.*pendiente/i, /^status$/i, /^estado$/i, /^situaci[oó]n$/i],
                  tipo: "texto", cardMin: 2, cardMax: 50, distintoDe: "estadoVencimiento" },
  textoCabecera:{ patrones: [/texto.*cabecera/i, /header.*text/i, /^referencia$/i, /^glosa$/i],
                  tipo: "texto" },
  documentoId:  { patrones: [/n[uú]mero.*documento.*legal/i, /documento.*legal/i,
                             /^n[uú]mero.*documento/i, /document.*number/i],
                  cardMin: 2 },
  documentoId2: { patrones: [/n[uú]mero.*documento.*sd/i, /documento.*sd/i, /^referencia/i],
                  cardMin: 2, distintoDe: "documentoId" },
  anioProvision:{ patrones: [/^a[ñn]o\s*provi/i, /^a[ñn]o$/i, /^year$/i, /^ejercicio$/i],
                  tipo: "numero", cardMin: 1, cardMax: 80, rango: [1990, 2100] },
  mesProvision: { patrones: [/^mes\s*provi/i, /^mes$/i, /^month$/i],
                  tipo: "numero", cardMin: 1, cardMax: 12, rango: [1, 12] },
  dsoPeriodo:   { patrones: [/^per[ií]odo$/i, /^mes$/i, /^fecha$/i],
                  cardMin: 3, enTablaDe: "dso" },
  obsCliente:   { patrones: [/^column1$/i, /^cliente$/i, /^nombre$/i],
                  tipo: "texto", enTablaDe: "observaciones" },
  obsTexto:     { patrones: [/^column15$/i, /observaci/i, /^comentario/i, /^nota/i, /^detalle$/i],
                  tipo: "texto", enTablaDe: "observaciones", largo: true }
};

/** El orden de resolución: lo que sirve de ancla va primero. */
const ORDEN = ["periodo", "clienteNombre", "sociedad", "canal", "vertical", "agingTramo",
  "clienteRazon", "clienteKam", "clienteNumero", "tramoFacturacion", "estadoVencimiento",
  "riesgo", "claseDocumento", "tipoDeuda", "condicionPago", "moneda", "concepto",
  "tipoProvision", "statusPendiente", "textoCabecera", "documentoId", "documentoId2",
  "anioProvision", "mesProvision", "dsoPeriodo", "obsCliente", "obsTexto"];

/** ¿El valor parece un mes? Devuelve el formato, o null. */
function formatoDeMes(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return "texto";
  if (/^\d{4}(0[1-9]|1[0-2])$/.test(s)) return "numero";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "fecha";
  return null;
}

/* ── tablas por su forma, no por su nombre ───────────────────────────────
   Una tabla de hechos tiene importes: columnas numéricas con muchos valores
   distintos. Una dimensión, en cambio, es casi toda texto. Y la del DSO —o
   cualquier serie suelta— se reconoce porque tiene un período y poco más. */
function perfilar(tablas) {
  const perfil = {};
  for (const t of Object.values(tablas)) {
    const cols = t.columnas || [];
    const numericas = cols.filter((c) => c.tipo === "numero" && c.cardinalidad > 20);
    const textos = cols.filter((c) => c.tipo === "texto");
    const conMes = cols.filter((c) => formatoDeMes(c.min));
    const fechas = cols.filter((c) => c.tipo === "fecha");
    /* Las partes de una fecha: año, trimestre, mes, semana, día, y sus
       nombres. Una tabla hecha casi toda de esto es un calendario. */
    const partes = cols.filter((c) => /^(a[ñn]o|year|trimestre|quarter|mes|month|semana|week|d[ií]a|day|fiscal|nro[\s_]*(mes|dia|semana))/i.test(c.nombre));
    perfil[t.nombre] = {
      nombre: t.nombre, columnas: cols.length,
      importes: numericas.length, textos: textos.length,
      hechos: numericas.length > 0 && cols.length > 2,
      /* Un calendario es casi todo fechas y partes de fecha, y no tiene
         importes: es la tabla a la que apuntan las demás, no una de hechos. */
      calendario: fechas.length >= 1 && cols.length >= 3 &&
        (fechas.length + conMes.length + partes.length) / cols.length >= 0.5,
      serie: cols.length <= 6 && conMes.length > 0 && numericas.length <= 3,
      /* Una hoja de observaciones traída de SharePoint: dos o tres columnas
         de texto, una de ellas con frases enteras. Se reconoce por la forma,
         o porque la columna se llama como lo que es. */
      observaciones: cols.length <= 6 && textos.length >= 2 &&
        textos.some((c) => (c.max === null ? 0 : String(c.max).length) > 40 ||
                           /observ|nota|coment|detalle/i.test(c.nombre))
    };
  }
  return perfil;
}

/** La tabla que tiene la serie de días en calle, si hay alguna. */
function tablaDeSerie(tablas, perfil) {
  const candidatas = Object.values(perfil).filter((p) => p.serie);
  if (!candidatas.length) return null;
  // la que tenga una columna numérica con nombre de días de cobro gana
  const conNombre = candidatas.find((p) => (tablas[p.nombre].columnas || [])
    .some((c) => /dso|d[ií]as.*(calle|cobro)|days\s*sales/i.test(c.nombre)));
  return (conNombre || candidatas[0]).nombre;
}

/** La tabla de observaciones: dos columnas de texto, una de ellas larga. */
function tablaDeObservaciones(tablas, perfil) {
  const c = Object.values(perfil).filter((p) => p.observaciones);
  return c.length ? c[0].nombre : null;
}

/**
 * El puntaje de una columna para un papel. 0 significa «no sirve».
 * Lo que más pesa es el nombre; el resto desempata.
 */
function puntuar(col, tabla, papel, ctx) {
  if (papel.tipo && col.tipo !== papel.tipo) return 0;
  if (papel.cardMin && !(col.cardinalidad >= papel.cardMin)) return 0;
  if (papel.cardMax && col.cardinalidad > papel.cardMax) return 0;
  if (papel.rango && col.tipo === "numero") {
    const lo = Number(col.min), hi = Number(col.max);
    if (!(lo >= papel.rango[0] && hi <= papel.rango[1])) return 0;
  }
  if (papel.mes && !formatoDeMes(col.min)) return 0;
  if (papel.largo && (col.max === null || String(col.max).length < 25)) return 0;
  if (papel.enTablaDe && ctx.tablasEspeciales[papel.enTablaDe] !== tabla) return 0;
  if (papel.distintoDe && ctx.elegidas[papel.distintoDe] === col.ref) return 0;

  let i = papel.patrones.findIndex((re) => re.test(col.nombre));
  if (i < 0) return 0;
  let puntos = 1000 - i * 40;

  /* Etiqueta antes que código. Los modelos traídos de SAP o de un datalake
     suelen tener el par `canal_distribucion_cd` / `canal_distribucion_name`:
     los dos calzan con el mismo patrón, pero uno se lee y el otro no. */
  /* El prefijo del origen no cuenta para emparejar: `canal_distribucion_cd` y
     `tb_comercial_contrato.canal_distribucion_name` son el mismo par. */
  const sufijo = /_(name|nombre|desc|descripcion|descripción|texto|label|cd|id|key|code|cod|codigo|código)$/i;
  const desnudo = (x) => x.slice(x.lastIndexOf(".") + 1).replace(sufijo, "");
  const raiz = desnudo(col.nombre);
  if (raiz !== col.nombre.slice(col.nombre.lastIndexOf(".") + 1)) {
    const hermanas = (ctx.columnasDe[tabla] || []).filter((x) =>
      x !== col.nombre && desnudo(x) === raiz);
    if (hermanas.length) {
      puntos += /_(name|nombre|desc|descripcion|descripción|texto|label)$/i.test(col.nombre) ? 30 : -55;
    }
  }

  /* Un nombre arrastrado del origen —`tb_comercial_contrato.canal_…`— es la
     misma columna que su versión limpia, pero sin curar. Entre las dos, la
     corta: es la que alguien decidió dejar a la vista. */
  if (col.nombre.includes(".")) puntos -= 20;

  /* Afinidad: los campos de un mismo asunto viven juntos. Si en esta tabla ya
     cayeron otros papeles, es más probable que éste también sea de acá. Pesa
     más que la preferencia por la etiqueta, porque ésa sólo tiene sentido
     entre dos columnas de la MISMA tabla. */
  puntos += Math.min(84, (ctx.porTabla[tabla] || 0) * 12);
  if (ctx.tablaAncla && tabla === ctx.tablaAncla) puntos += 15;
  const perf = ctx.perfil[tabla] || {};
  if (papel.prefiereCalendario) puntos += perf.calendario ? 120 : perf.hechos ? -60 : 0;
  else if (perf.hechos) puntos += 10;
  // una columna ya usada para otro papel vale menos, pero no está prohibida
  if (ctx.usadas.has(col.ref)) puntos -= 60;
  return puntos;
}

/**
 * El mapeo de columnas que se deduce de este inventario.
 *
 * Devuelve también `yaFiltrado`: las columnas con un solo valor en todo el
 * modelo, que son las que el Power Query dejó recortadas antes de que el
 * informe pregunte nada.
 */
function columnas(tablas) {
  const perfil = perfilar(tablas);
  const tablasEspeciales = {
    dso: tablaDeSerie(tablas, perfil),
    observaciones: tablaDeObservaciones(tablas, perfil)
  };
  const columnasDe = {};
  for (const t of Object.values(tablas)) columnasDe[t.nombre] = (t.columnas || []).map((c) => c.nombre);
  const ctx = { perfil, tablasEspeciales, elegidas: {}, usadas: new Set(),
                tablaAncla: null, porTabla: {}, columnasDe };

  for (const clave of ORDEN) {
    const papel = PAPELES[clave];
    let mejor = null;
    for (const t of Object.values(tablas)) {
      // la tabla de observaciones no aporta dimensiones al informe
      if (t.nombre === tablasEspeciales.observaciones && !papel.enTablaDe) continue;
      for (const col of t.columnas || []) {
        const p = puntuar(col, t.nombre, papel, ctx);
        if (p > 0 && (!mejor || p > mejor.puntos)) mejor = { puntos: p, col, tabla: t.nombre };
      }
    }
    if (!mejor) continue;
    ctx.elegidas[clave] = mejor.col.ref;
    ctx.usadas.add(mejor.col.ref);
    ctx.porTabla[mejor.tabla] = (ctx.porTabla[mejor.tabla] || 0) + 1;
    // el cliente marca la tabla de dimensiones: el resto suele vivir con él
    if (clave === "clienteNombre") ctx.tablaAncla = mejor.tabla;
    if (clave === "periodo") ctx.periodoFormato = formatoDeMes(mejor.col.min) || "numero";
  }

  const yaFiltrado = [];
  for (const t of Object.values(tablas)) {
    for (const col of t.columnas || []) {
      if (col.cardinalidad === 1 && col.tipo === "texto" && col.min != null) {
        yaFiltrado.push({ ref: col.ref, columna: col.nombre, tabla: t.nombre, valor: String(col.min) });
      }
    }
  }

  return {
    columnas: ctx.elegidas,
    periodoFormato: ctx.periodoFormato || "numero",
    tablas: tablasEspeciales,
    perfil,
    yaFiltrado
  };
}

/* ══ medidas armadas con lo que hay ══════════════════════════════════════
   Un modelo puede no tener ninguna medida: los importes están en columnas y
   los gráficos del tablero los suman al vuelo. Ahí no hay nada que "detectar",
   hay que construir. Estas son las sumas que un informe de deuda necesita,
   expresadas sobre las columnas del propio modelo.

   Se usan sólo para lo que no apareció como medida del modelo: una medida
   escrita por quien armó el tablero lleva reglas de negocio —qué tramos
   cuentan como vencido, por ejemplo— que una suma no puede adivinar. */
const MEDIDA_DE = {
  /* Los importes, por lo que suelen llamarse en un datalake. El orden importa:
     el primer patrón que calza puntúa más. */
  real:             { patrones: [/^importe\s*real$/i, /^real$/i, /venta.*real/i, /^venta\s*neta/i,
                                 /^ventas?$/i, /^facturaci[oó]n$/i, /^ingresos?$/i, /^revenue$/i,
                                 /^actual$/i, /^sales$/i, /^net\s*sales$/i], agregado: "SUM" },
  bo:               { patrones: [/^importe\s*presupuest/i, /^presupuest/i, /^ppto/i, /^budget$/i,
                                 /^objetivo$/i, /^bo$/i, /^plan$/i, /^forecast$/i, /^target$/i,
                                 /^meta$/i, /presupuest/i], agregado: "SUM" },
  opex:             { patrones: [/^opex$/i, /gasto.*operativ/i, /^gastos?$/i, /^egresos?$/i,
                                 /operating.*expense/i, /^sg&a$/i], agregado: "SUM" },
  costos:           { patrones: [/^costos?$/i, /^cmv$/i, /^cogs$/i, /costo.*vent/i,
                                 /^costo\s*directo/i], agregado: "SUM" },
  saldoCxC:         { patrones: [/cuentas.*cobrar/i, /^cxc$/i, /receivable/i, /^saldo\s*deuda/i,
                                 /^saldo$/i], agregado: "SUM" },
  provisiones:      { patrones: [/^provisi/i, /^importe\s*provisi/i], agregado: "SUM" },
  deudaCobranza:    { patrones: [/^importe\s*total$/i, /^saldo\s*deuda/i, /^deuda/i,
                                 /^balance$/i, /^importe\s*adeudado/i], agregado: "SUM" },
  deudaFacturacion: { patrones: [/pendiente.*factur/i, /por.*factur/i, /^wip$/i,
                                 /unbilled/i, /obra.*curso/i], agregado: "SUM" },
  importeFacturado: { patrones: [/importe.*factur/i, /^facturado$/i, /invoiced/i], agregado: "SUM" },
  dso:              { patrones: [/^dso/i, /d[ií]as.*(calle|cobro)/i, /days\s*sales/i], agregado: "MIN" }
};

/* Lo que no se suma: se calcula sobre otras. Un modelo puede no tener escrita
   la variación ni el margen —son dos restas— y no por eso el informe tiene que
   quedarse sin ellas. Se arman sólo si están sus dos ingredientes. */
const DERIVADAS = {
  variacion:     { de: ["real", "bo"], arma: (r, b) => `${r} - ${b}` },
  variacionPct:  { de: ["real", "bo"], arma: (r, b) => `DIVIDE(${r} - ${b}, ${b}) * 100` },
  margen:        { de: ["real", "costos"], arma: (r, c) => `${r} - ${c}` },
  margenPct:     { de: ["margen", "real"], arma: (m, r) => `DIVIDE(${m}, ${r}) * 100` },
  ebitda:        { de: ["margen", "opex"], arma: (m, o) => `${m} - ${o}` },
  margenEbitda:  { de: ["ebitda", "real"], arma: (e, r) => `DIVIDE(${e}, ${r}) * 100` },
  facturacion:   { de: ["real"], arma: (r) => r },
  pendienteFacturar: { de: ["deudaFacturacion"], arma: (x) => x },
  deudaTotal:    { de: ["deudaCobranza", "deudaFacturacion"], arma: (c, f) => `${c} + ${f}` },
  indiceRiesgo:  { de: ["deudaVencida", "deudaTotal"], arma: (v, t) => `DIVIDE(${v}, ${t}) * 100` }
};

/* El orden en que se resuelven: una derivada puede apoyarse en otra. */
const ORDEN_DERIVADAS = ["facturacion", "pendienteFacturar", "variacion", "variacionPct",
  "margen", "margenPct", "ebitda", "margenEbitda", "deudaTotal", "indiceRiesgo"];

/**
 * Las medidas que se pueden armar con lo que el modelo tiene, para los papeles
 * que no aparecieron como medida escrita.
 *
 * Primero las que son una suma de una columna, y después las que son una
 * cuenta sobre esas. Una medida del modelo siempre gana: lleva reglas de
 * negocio —qué tramos cuentan como vencido, qué se excluye— que una suma no
 * puede adivinar.
 */
function medidasSinteticas(tablas, perfil, yaMapeadas, columnasElegidas) {
  const salida = {};
  const puesto = {};                       // papel → DAX efectivo, propio o armado
  for (const [k, nombre] of Object.entries(yaMapeadas || {})) {
    if (nombre) puesto[k] = "[" + nombre + "]";
  }

  // ── las que salen de sumar una columna ─────────────────────────────
  const usadas = new Set();
  for (const [clave, papel] of Object.entries(MEDIDA_DE)) {
    if (puesto[clave]) continue;
    let mejor = null;
    for (const t of Object.values(tablas)) {
      for (const col of t.columnas || []) {
        if (col.tipo !== "numero") continue;
        // un año o un mes no son un importe, por más que sean números
        if (col.cardinalidad < 3 || (col.max !== null && col.max <= 12)) continue;
        const i = papel.patrones.findIndex((re) => re.test(col.nombre));
        if (i < 0) continue;
        let puntos = 1000 - i * 40;
        if ((perfil[t.nombre] || {}).hechos) puntos += 60;
        if (col.cardinalidad > 20) puntos += 20;
        if (usadas.has(col.ref)) puntos -= 200;   // no repetir la misma columna
        if (!mejor || puntos > mejor.puntos) mejor = { puntos, ref: col.ref };
      }
    }
    if (!mejor) continue;
    salida[clave] = papel.agregado + "(" + mejor.ref + ")";
    puesto[clave] = salida[clave];
    usadas.add(mejor.ref);
  }

  // la cantidad de clientes se cuenta sobre la columna que ya se eligió
  if (!puesto.clientesActivos && (columnasElegidas || {}).clienteNombre) {
    salida.clientesActivos = "DISTINCTCOUNT(" + columnasElegidas.clienteNombre + ")";
    puesto.clientesActivos = salida.clientesActivos;
  }

  // ── las que son una cuenta sobre las anteriores ────────────────────
  for (const clave of ORDEN_DERIVADAS) {
    if (puesto[clave]) continue;
    const d = DERIVADAS[clave];
    const partes = d.de.map((k) => puesto[k]);
    if (partes.some((x) => !x)) continue;
    salida[clave] = d.arma(...partes);
    puesto[clave] = salida[clave];
  }
  return salida;
}

module.exports = { columnas, perfilar, formatoDeMes, medidasSinteticas,
                   PAPELES, ORDEN, MEDIDA_DE, DERIVADAS };
