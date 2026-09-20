"use strict";
/**
 * Lee el modelo semántico del tablero, solo, sin que nadie configure nada.
 *
 * Dos cosas distintas, que acá van juntas porque se necesitan mutuamente:
 *
 *   1. EL INVENTARIO — qué tablas y columnas hay, de qué tipo y con cuántos
 *      valores distintos. Sale de `COLUMNSTATISTICS()`, que es DAX estándar y
 *      por lo tanto pasa por executeQueries. Las funciones INFO, que serían
 *      lo natural, están explícitamente fuera de esta API (error 3239575574);
 *      la API Arrow sí las admite pero es sólo Premium/Fabric, así que no se
 *      puede depender de ella.
 *
 *   2. EL ALCANCE — qué tabla puede filtrar a qué medida. No se deduce de las
 *      relaciones declaradas y por eso se pregunta al motor: se filtra una
 *      tabla y se mira si la medida se movió.
 *
 *      Esto es lo que las relaciones NO cuentan. En un modelo de deuda real,
 *      [Deuda Facturacion] = CALCULATE(SUM(Provision[...]), Provision): el
 *      argumento de tabla le saca los filtros de su propia tabla. Un grafo de
 *      relaciones diría que Provision la filtra; el motor dice que no. Y al
 *      revés, la tabla de aging no llega a la provisión por ninguna relación,
 *      así que meterle sus filtros a una consulta de facturación es, en el
 *      mejor caso, ruido caro.
 *
 * Con las dos cosas, el generador arma cada consulta con los filtros que de
 * verdad le corresponden, y nadie tiene que escribir un mapeo a mano.
 */
const { consultar, consultarVarias } = require("./client");

/** `Mi Tabla` necesita comillas simples en DAX; `Ventas` no. */
const refTabla = (n) => (/^[A-Za-zÀ-ÿ_][\wÀ-ÿ]*$/.test(n) ? n : "'" + String(n).replace(/'/g, "''") + "'");
const refColumna = (tabla, col) => refTabla(tabla) + "[" + col + "]";

/* Las tablas de fecha que Power BI crea solo por cada columna de fecha. No
   son del modelo: son plomería, y listarlas ensucia todo lo que viene después. */
const PLOMERIA = /^(LocalDateTable_|DateTableTemplate_)/;

/** Un literal DAX seguro a partir de un valor cualquiera del inventario. */
function literal(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "boolean") return v ? "TRUE()" : "FALSE()";
  const s = String(v);
  if (/[\r\n]/.test(s) || s.length > 120) return null;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** De qué tipo es una columna, mirando lo que devolvió COLUMNSTATISTICS. */
function tipoDe(min, max) {
  const v = min !== null && min !== undefined ? min : max;
  if (typeof v === "number") return "numero";
  if (typeof v === "boolean") return "logico";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return "fecha";
  return "texto";
}

/* ══ 1 · el inventario ═══════════════════════════════════════════════════ */

/**
 * Todas las tablas y columnas del modelo, con cardinalidad.
 *
 * `COLUMNSTATISTICS()` devuelve una fila por columna de cada tabla, con el
 * mínimo, el máximo y la cantidad de valores distintos. Es una sola consulta
 * y reemplaza a adivinar nombres.
 */
async function inventario(ws, ds) {
  const filas = await consultar(ws, ds, "\nEVALUATE COLUMNSTATISTICS()");
  const tablas = {};
  for (const f of filas || []) {
    const tabla = f["Table Name"], col = f["Column Name"];
    if (!tabla || !col || PLOMERIA.test(tabla)) continue;
    // las columnas que Power BI agrega a las jerarquías de fecha no son datos
    if (/^(Year|Quarter|Month|Day|QuarterNo|MonthNo|DayNoOfWeek)$/.test(col) &&
        /Date|Fecha/i.test(tabla) && PLOMERIA.test(tabla)) continue;
    const t = tablas[tabla] || (tablas[tabla] = { nombre: tabla, columnas: [] });
    const card = Number(f["Cardinality"]);
    t.columnas.push({
      nombre: col,
      ref: refColumna(tabla, col),
      cardinalidad: Number.isFinite(card) ? card : null,
      min: f["Min"] === undefined ? null : f["Min"],
      max: f["Max"] === undefined ? null : f["Max"],
      tipo: tipoDe(f["Min"], f["Max"])
    });
  }
  return tablas;
}

/* ══ 2 · el alcance ══════════════════════════════════════════════════════ */

/**
 * Una columna de la tabla que sirva para probar: ni constante —filtrarla no
 * cambiaría nada y la prueba diría que no alcanza— ni una clave de millones
 * de valores, que hace cara la consulta.
 */
function columnaDeSonda(tabla) {
  const utiles = (tabla.columnas || [])
    .filter((c) => c.tipo !== "fecha" && c.cardinalidad > 1 && c.min !== null)
    .sort((a, b) => a.cardinalidad - b.cardinalidad);
  // la de menor cardinalidad por encima de 1: la más barata de filtrar
  const elegida = utiles.find((c) => c.cardinalidad >= 2 && c.cardinalidad <= 5000) || utiles[0];
  if (!elegida) return null;
  const val = literal(elegida.min);
  return val ? { ref: elegida.ref, valor: val } : null;
}

/**
 * Qué tablas mueven a cada medida.
 *
 * Se pregunta al motor en vez de deducirlo: para cada tabla se saca un valor
 * —`<> el mínimo`, que siempre recorta algo— y se mira qué medidas cambiaron.
 * La que no se movió no depende de esa tabla, y meterle ese filtro sólo puede
 * hacer daño.
 *
 * Una consulta por tabla, todas las medidas juntas en cada una. Con seis
 * tablas son siete consultas, y el resultado se guarda para toda la sesión.
 */
async function alcance(ws, ds, medidas, tablas) {
  const claves = Object.keys(medidas).filter((k) => medidas[k]);
  if (!claves.length) return {};
  const fila = claves.map((k) => `      "${k}", ${medidas[k]}`).join(",\n");

  const sondas = {};
  for (const t of Object.values(tablas)) {
    const s = columnaDeSonda(t);
    if (s) sondas[t.nombre] = s;
  }

  const pedidos = { base: `\nEVALUATE\n  ROW(\n${fila}\n  )` };
  for (const [nombre, s] of Object.entries(sondas)) {
    pedidos["t:" + nombre] = `\nEVALUATE\n  CALCULATETABLE(\n    ROW(\n${fila}\n    ),\n` +
      `    FILTER(ALL(${refTabla(nombre)}), ${s.ref} <> ${s.valor})\n  )`;
  }

  const r = await consultarVarias(ws, ds, pedidos);
  const base = (r.base || [])[0] || {};
  const totales = { ...base };

  const mapa = {};
  for (const k of claves) mapa[k] = {};
  for (const nombre of Object.keys(sondas)) {
    const f = (r["t:" + nombre] || [])[0];
    for (const k of claves) {
      // sin respuesta no se concluye nada: se deja que el filtro se aplique,
      // que es el comportamiento de siempre
      if (!f) { mapa[k][nombre] = true; continue; }
      mapa[k][nombre] = !igual(base[k], f[k]);
    }
  }
  return { mapa, totales };
}

/** Dos lecturas de la misma medida, comparadas con tolerancia de redondeo. */
function igual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    const escala = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) <= escala * 1e-9;
  }
  // blanco contra cero: la medida no se movió, sólo cambió cómo lo dice
  const nulo = (x) => x === null || x === undefined || x === 0;
  return nulo(a) && nulo(b);
}

/* ══ 3 · la columna detrás de cada medida ════════════════════════════════ */

/**
 * Qué columna suma cada medida.
 *
 * Hace falta para abrir una medida por una tabla que la medida ignora. El
 * caso: [Deuda Facturacion] = CALCULATE(SUM(Provision[PENDIENTE FACTURAR]),
 * Provision) no reacciona a los filtros de Provision, así que pedirla abierta
 * por mes devuelve el total entero en cada mes —los meses no suman al total y
 * la apertura miente. Con la columna, la apertura se hace sobre ella y cierra.
 *
 * Se encuentra sin nombres a mano: se suman todas las columnas numéricas del
 * modelo y se busca la que da el mismo total que la medida. Si ninguna coincide
 * —una medida con lógica propia, como la deuda vencida— no se devuelve nada y
 * el informe simplemente no ofrece esa apertura.
 */
const TOPE_COLUMNAS = 150;   // lo que entra en dos o tres EVALUATE
const POR_EVALUATE = 50;

async function columnasDetras(ws, ds, medidas, tablas, totales) {
  const claves = Object.keys(medidas).filter((k) => typeof totales[k] === "number" && totales[k] !== 0);
  if (!claves.length) return {};

  const candidatas = [];
  for (const t of Object.values(tablas)) {
    for (const c of t.columnas) {
      // los importes varían; una columna de dos valores es una bandera
      if (c.tipo !== "numero" || !(c.cardinalidad >= 3)) continue;
      candidatas.push(c.ref);
    }
  }
  if (!candidatas.length || candidatas.length > TOPE_COLUMNAS * 4) return {};

  const pedidos = {};
  const recortadas = candidatas.slice(0, TOPE_COLUMNAS);
  for (let i = 0; i < recortadas.length; i += POR_EVALUATE) {
    const trozo = recortadas.slice(i, i + POR_EVALUATE);
    pedidos["c" + i] = "\nEVALUATE\n  ROW(\n" +
      trozo.map((ref, j) => `      "s${i + j}", SUM(${ref})`).join(",\n") + "\n  )";
  }

  let r;
  try { r = await consultarVarias(ws, ds, pedidos); } catch (e) { return {}; }

  const suma = {};
  for (const [llave, filas] of Object.entries(r)) {
    const fila = (filas || [])[0] || {};
    const base = Number(llave.slice(1));
    for (const [k, v] of Object.entries(fila)) {
      const j = Number(String(k).replace(/^s/, ""));
      if (Number.isFinite(j) && typeof v === "number") suma[recortadas[j]] = v;
      void base;
    }
  }

  const salida = {};
  for (const k of claves) {
    const busco = totales[k];
    const calza = Object.entries(suma).find(([, v]) => igual(v, busco));
    if (calza) salida[k] = calza[0];
  }
  return salida;
}

/* ══ caché ═══════════════════════════════════════════════════════════════
   Leer el modelo cuesta unas pocas consultas, pero no tiene sentido pagarlas
   en cada informe: el modelo no cambia entre dos cargas de la misma pantalla. */
const memoria = new Map();
const VIGENCIA = 10 * 60 * 1000;

/**
 * El modelo semántico de este tablero, leído una vez y recordado.
 *
 * Nunca tira: si el tablero no deja correr COLUMNSTATISTICS —pasa en modelos
 * con seguridad a nivel de fila muy cerrada— devuelve lo que pudo y avisa.
 * El informe sigue andando como antes, sólo que sin la mejora.
 */
async function leer(ws, ds, medidas) {
  const llave = ws + ":" + ds + ":" + Object.values(medidas || {}).sort().join("|");
  const guardado = memoria.get(llave);
  if (guardado && Date.now() - guardado.cuando < VIGENCIA) return guardado.valor;

  const salida = { tablas: {}, alcance: {}, totales: {}, columna: {}, leido: false, aviso: null };
  try {
    salida.tablas = await inventario(ws, ds);
    salida.leido = true;
  } catch (e) {
    salida.aviso = "No se pudo leer el inventario del modelo (" + e.message +
      "); el informe usa el mapeo guardado.";
    memoria.set(llave, { cuando: Date.now(), valor: salida });
    return salida;
  }
  try {
    const a = await alcance(ws, ds, medidas || {}, salida.tablas);
    salida.alcance = a.mapa;
    salida.totales = a.totales;
    salida.columna = await columnasDetras(ws, ds, medidas || {}, salida.tablas, a.totales);
  } catch (e) {
    salida.aviso = "No se pudo medir qué filtra a qué (" + e.message +
      "); se aplican todos los filtros, como antes.";
  }
  memoria.set(llave, { cuando: Date.now(), valor: salida });
  return salida;
}

/** Olvidar lo leído: al cambiar de tablero, o cuando el usuario reinicia. */
function olvidar() { memoria.clear(); }

module.exports = { leer, olvidar, inventario, alcance, columnasDetras, refTabla, refColumna, tipoDe, literal };
