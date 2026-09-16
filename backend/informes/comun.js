"use strict";
/**
 * Piezas compartidas por los informes.
 *
 * Regla de oro: si el modelo no tiene una medida, la tarjeta o la sección
 * simplemente no se dibuja. Un modelo sin DSO da un informe sin DSO, no un
 * error.
 */
const { m } = require("../powerbi/queries");

const MES_CORTO = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

/** 202607 → "Jul 26" */
function etiquetaMes(clave) {
  const k = Number(clave);
  if (!k || k < 100001) return String(clave);
  return MES_CORTO[(k % 100) - 1] + " " + String(Math.floor(k / 100)).slice(2);
}

/** Descarta las tarjetas cuyo valor no vino y los gráficos sin datos. */
function limpiar(secciones) {
  return secciones.filter(Boolean).filter((s) => {
    if (s.tipo === "kpis") {
      s.items = (s.items || []).filter((k) => k && k.valor !== undefined && k.valor !== null);
      return s.items.length > 0;
    }
    if (s.items) return s.items.length > 0;
    if (s.series) return s.series.length > 0 && (s.ejeX || []).length > 0;
    if (s.filas) return s.filas.length > 0;
    return true;
  });
}

/**
 * Variación: se usa la medida del modelo si existe; si no, la diferencia.
 * Es la única cuenta que hace el backend, y sólo porque Real − BO no es
 * lógica de negocio que pueda diferir del tablero.
 */
function variacion(k) {
  if (k.variacion !== undefined && k.variacion !== null) return k.variacion;
  if (typeof k.real === "number" && typeof k.bo === "number") return k.real - k.bo;
  return undefined;
}
function variacionPct(k) {
  if (k.variacionPct !== undefined && k.variacionPct !== null) return k.variacionPct;
  const v = variacion(k);
  if (typeof v === "number" && typeof k.bo === "number" && k.bo !== 0) return (v / k.bo) * 100;
  return undefined;
}

/** Sólo devuelve la tarjeta si la medida está mapeada y vino con valor. */
function kpi(clave, k, extra) {
  if (!m(clave)) return null;
  const v = k[clave];
  if (v === undefined || v === null) return null;
  return Object.assign({ valor: v }, extra);
}

module.exports = { MES_CORTO, etiquetaMes, limpiar, variacion, variacionPct, kpi };
