"use strict";
/**
 * Plantillas DAX por informe.
 *
 * Los filtros que manda el artefacto se interpolan como literales DAX, así que
 * pasan siempre por `lit()`: un valor con comillas o saltos de línea podría
 * cambiar el sentido de la consulta.
 *
 * Los nombres de tablas, columnas y medidas de acá abajo son los del modelo de
 * ejemplo. Ajustalos a los tuyos una sola vez: el artefacto no necesita saber
 * cómo se llaman.
 */

/** Literal de texto DAX: comilla doble escapada duplicándola. */
function lit(valor) {
  const s = String(valor == null ? "" : valor);
  if (s.length > 120) throw new Error("Valor de filtro demasiado largo");
  // \p{Zl}/\p{Zp} cubren los separadores de línea que no son \n
  if (/[\r\n]/.test(s) || /\p{Zl}|\p{Zp}/u.test(s)) throw new Error("Valor de filtro inválido");
  return '"' + s.replace(/"/g, '""') + '"';
}

/** "2026-07" → 202607, el entero de la clave de calendario. */
function claveMes(periodo) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || "")) {
    throw new Error("El período debe tener formato AAAA-MM");
  }
  return Number(periodo.replace("-", ""));
}

/**
 * Filtros opcionales como argumentos de SUMMARIZECOLUMNS / CALCULATETABLE.
 * Devuelve las líneas ya formateadas, o cadena vacía si no hay filtro.
 */
function filtros({ periodo, sociedad, vertical }) {
  const partes = [`Calendario[ClaveMes] = ${claveMes(periodo)}`];
  if (sociedad && sociedad !== "Todas") partes.push(`Sociedad[Nombre] = ${lit(sociedad)}`);
  if (vertical && vertical !== "Todas") partes.push(`Vertical[Nombre] = ${lit(vertical)}`);
  return partes.map((p) => `    FILTER(ALL(${p.split("[")[0]}), ${p})`).join(",\n");
}

/** Igual que `filtros` pero sin acotar el mes: para series de 12 meses. */
function filtrosSinMes({ sociedad, vertical }) {
  const partes = [];
  if (sociedad && sociedad !== "Todas") partes.push(`Sociedad[Nombre] = ${lit(sociedad)}`);
  if (vertical && vertical !== "Todas") partes.push(`Vertical[Nombre] = ${lit(vertical)}`);
  if (!partes.length) return "";
  return "\n" + partes.map((p) => `    FILTER(ALL(${p.split("[")[0]}), ${p}),`).join("\n");
}

/** Los N meses que terminan en `periodo`, como claves AAAAMM. */
function ventanaMeses(periodo, n) {
  const [a, m] = periodo.split("-").map(Number);
  const claves = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(a, m - 1 - i, 1));
    claves.push(d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1));
  }
  return claves;
}

module.exports = { lit, claveMes, filtros, filtrosSinMes, ventanaMeses };
