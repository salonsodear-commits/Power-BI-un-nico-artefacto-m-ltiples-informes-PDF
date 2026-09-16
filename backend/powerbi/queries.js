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

/** Filtro del mes pedido. */
function fPeriodo(periodo) {
  const col = c("periodo");
  if (!col) throw new Error("Falta mapear la columna de período del calendario");
  return `FILTER(ALL(${tablaDe(col)}), ${col} = ${claveMes(periodo)})`;
}

/** Filtro de la ventana de n meses que termina en `periodo`. */
function fVentana(periodo, n) {
  const col = c("periodo");
  if (!col) throw new Error("Falta mapear la columna de período del calendario");
  return `FILTER(ALL(${tablaDe(col)}), ${col} IN {${ventanaMeses(periodo, n).join(", ")}})`;
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

module.exports = {
  m, c, tablaDe, lit, claveMes, ventanaMeses,
  fPeriodo, fVentana, fDimensiones, argsFiltro, filaMedidas, colsMedidas
};
