"use strict";
/**
 * Construcción de DAX a partir del mapeo del modelo.
 *
 * Nada de nombres de medidas o columnas fijos: todo sale de modelo.json, que
 * es lo que hace que el mismo generador sirva para cualquier tablero.
 *
 * Todo lo que se interpola acá viene ya validado por modelo.js (sólo formas
 * `[Medida]` y `Tabla[Columna]`) o pasa por `lit()`.
 */
const MODELO = require("../modelo");
const { tablaDe } = MODELO;

/** Referencia de medida mapeada, o null si el modelo no la tiene. */
const m = (clave) => MODELO.leer().medidas[clave] || null;
/** Referencia de columna mapeada, o null. */
const c = (clave) => MODELO.leer().columnas[clave] || null;

/** Literal de texto DAX: la comilla doble se escapa duplicándola. */
function lit(valor) {
  const s = String(valor == null ? "" : valor);
  if (s.length > 120) throw new Error("Valor de filtro demasiado largo");
  // \p{Zl}/\p{Zp} cubren los separadores de línea que no son \n
  if (/[\r\n]/.test(s) || /\p{Zl}|\p{Zp}/u.test(s)) throw new Error("Valor de filtro inválido");
  return '"' + s.replace(/"/g, '""') + '"';
}

/** "2026-07" → 202607 */
function claveMes(periodo) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || "")) {
    throw new Error("El período debe tener formato AAAA-MM");
  }
  return Number(periodo.replace("-", ""));
}

/** Los n meses que terminan en `periodo`, como claves AAAAMM. */
function ventanaMeses(periodo, n) {
  const k = claveMes(periodo);
  const a = Math.floor(k / 100), mes = k % 100;
  const claves = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(a, mes - 1 - i, 1));
    claves.push(d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1));
  }
  return claves;
}

/**
 * El valor con el que se compara la columna de período, en su propio tipo.
 * Un modelo guarda el mes como entero 202607 o como texto "2026-07"; los dos
 * son igual de comunes y el literal DAX es distinto.
 */
function valorPeriodo(clave) {
  const s = String(clave);
  return MODELO.leer().periodoFormato === "texto"
    ? lit(s.slice(0, 4) + "-" + s.slice(4))
    : s;
}

/** Filtro del mes pedido. */
function fPeriodo(periodo) {
  const col = c("periodo");
  if (!col) throw new Error("Falta mapear la columna de período del calendario");
  return `FILTER(ALL(${tablaDe(col)}), ${col} = ${valorPeriodo(claveMes(periodo))})`;
}

/** Filtro de la ventana de n meses que termina en `periodo`. */
function fVentana(periodo, n) {
  const col = c("periodo");
  if (!col) throw new Error("Falta mapear la columna de período del calendario");
  const vals = ventanaMeses(periodo, n).map(valorPeriodo).join(", ");
  return `FILTER(ALL(${tablaDe(col)}), ${col} IN {${vals}})`;
}

/** Filtros de sociedad y vertical, sólo los que estén mapeados y pedidos. */
function fDimensiones({ sociedad, vertical }) {
  const partes = [];
  for (const [clave, valor] of [["sociedad", sociedad], ["vertical", vertical]]) {
    const col = c(clave);
    if (!col || !valor || valor === "Todas") continue;
    partes.push(`FILTER(ALL(${tablaDe(col)}), ${col} = ${lit(valor)})`);
  }
  return partes;
}

/** Todos los filtros, ya listos para pegar como argumentos. */
function argsFiltro(p, { ventana } = {}) {
  const partes = [ventana ? fVentana(p.periodo, ventana) : fPeriodo(p.periodo), ...fDimensiones(p)];
  return partes.map((x) => "    " + x).join(",\n");
}

/**
 * `ROW(...)` con las medidas que el modelo realmente tiene.
 * Las que faltan no se piden: el informe después saltea esa tarjeta.
 */
function filaMedidas(claves) {
  const usables = claves.filter((k) => m(k));
  if (!usables.length) return null;
  return usables.map((k) => `      "${k}", ${m(k)}`).join(",\n");
}

/** `"clave", Medida` para SUMMARIZECOLUMNS, salteando lo no mapeado. */
function colsMedidas(claves) {
  return claves.filter((k) => m(k)).map((k) => `    "${k}", ${m(k)}`);
}

/**
 * Una apertura: la medida abierta por una o más columnas.
 *
 * Es el ladrillo de todo el detalle del tablero de deuda. Devuelve null si el
 * modelo no tiene alguna de las piezas, para que el informe saltee esa vista
 * en vez de fallar.
 *
 *   desglose({ por: [c("concepto")], medidas: ["deudaFacturacion"], tope: 40 })
 */
function desglose({ por, medidas, filtros = [], tope = 0, orden = null, desc = true }) {
  const dims = (Array.isArray(por) ? por : [por]).filter(Boolean);
  const cols = colsMedidas(medidas || []);
  if (!dims.length || !cols.length) return null;

  const cuerpo = [
    ...dims.map((x) => "    " + x),
    ...filtros.filter(Boolean).map((x) => "    " + x),
    ...cols
  ].join(",\n");

  // el orden por defecto es la primera medida que el modelo sí tiene
  const clave = orden || (medidas || []).find((k) => m(k));
  const porOrden = clave ? `\n  ORDER BY [${clave}] ${desc ? "DESC" : "ASC"}` : "";

  const tabla = `SUMMARIZECOLUMNS(\n${cuerpo}\n  )`;
  return tope
    ? `\nEVALUATE\n  TOPN(\n    ${tope},\n  ${tabla.replace(/\n/g, "\n  ")},\n    [${clave}], ${desc ? "DESC" : "ASC"}\n  )${porOrden}`
    : `\nEVALUATE\n  ${tabla}${porOrden}`;
}

/** Los valores distintos de una columna, para saber si el tablero ya la filtró. */
function valoresDe(col, tope = 12) {
  if (!col) return null;
  return `\nEVALUATE\n  TOPN(${tope}, SUMMARIZECOLUMNS(${col}))`;
}

module.exports = {
  m, c, tablaDe, lit, claveMes, ventanaMeses, valorPeriodo,
  fPeriodo, fVentana, fDimensiones, argsFiltro, filaMedidas, colsMedidas,
  desglose, valoresDe
};
