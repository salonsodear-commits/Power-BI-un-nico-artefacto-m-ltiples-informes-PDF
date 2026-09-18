"use strict";
/**
 * Execute Queries contra el modelo semántico.
 * POST /v1.0/myorg/groups/{groupId}/datasets/{datasetId}/executeQueries
 * https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group
 *
 * Límites documentados por consulta: 100.000 filas o 1.000.000 de valores,
 * 15 MB y 120 consultas por minuto y por usuario. Por eso cada informe pide
 * sólo lo suyo. (Manual, paso 12.)
 */
const { obtenerToken } = require("./auth");

const BASE = "https://api.powerbi.com/v1.0/myorg";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── control de caudal ────────────────────────────────────────────────
   Power BI admite 120 consultas por minuto y por usuario, pero además
   estrangula las ráfagas: un informe que dispara treinta pedidos a la vez
   se come un 429 y no carga nada. Dos medidas, en este orden:

   1. Varios EVALUATE en UNA consulta. La API devuelve una tabla por cada
      uno, y Microsoft recomienda esto justamente para no chocar con el
      límite. Treinta pedidos pasan a ser cuatro.
   2. Y aun así, poca concurrencia y reintento con espera al 429.

   https://learn.microsoft.com/power-bi/developer/execute-dax-queries-arrow/best-practices */

const POR_TANDA = 8;      // EVALUATE por pedido
const A_LA_VEZ = 3;       // pedidos simultáneos
const REINTENTOS = 3;

/** Deja pasar como mucho `A_LA_VEZ` promesas al mismo tiempo. */
function conCupo(limite) {
  let libres = limite;
  const cola = [];
  const soltar = () => { libres++; const sig = cola.shift(); if (sig) sig(); };
  return (fn) => new Promise((ok, mal) => {
    const correr = () => {
      libres--;
      fn().then(ok, mal).finally(soltar);
    };
    libres > 0 ? correr() : cola.push(correr);
  });
}
const cupo = conCupo(A_LA_VEZ);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Un pedido a executeQueries con reintento. El 429 trae `Retry-After` casi
 * siempre; cuando no, se espera un poco más en cada vuelta.
 */
async function pedir(workspaceId, datasetId, daxs) {
  if (!GUID.test(workspaceId || "")) throw new Error("workspaceId no es un GUID válido");
  if (!GUID.test(datasetId || "")) throw new Error("datasetId no es un GUID válido");

  for (let intento = 0; ; intento++) {
    const token = await obtenerToken();
    const r = await cupo(() => fetch(
      `${BASE}/groups/${workspaceId}/datasets/${datasetId}/executeQueries`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: daxs.map((q) => ({ query: q })),
          serializerSettings: { includeNulls: true }
        })
      }));

    const texto = await r.text();
    if (r.ok) {
      const j = JSON.parse(texto);
      const tablas = ((j.results || [])[0] || {}).tables || [];
      return daxs.map((_, i) => ((tablas[i] || {}).rows || []).map(normalizarClaves));
    }

    if (r.status === 429 && intento < REINTENTOS) {
      const dice = Number(r.headers.get("retry-after"));
      const espera = Number.isFinite(dice) && dice > 0
        ? dice * 1000 : Math.min(2000 * Math.pow(2, intento), 20000);
      console.warn(`[powerbi] 429: espero ${Math.round(espera / 1000)} s y reintento ` +
                   `(${intento + 1}/${REINTENTOS})`);
      await dormir(espera);
      continue;
    }

    const err = new Error(r.status === 429
      ? "Power BI está limitando las consultas (429). Probá de nuevo en un minuto."
      : "Power BI: " + mensajeDeError(texto, r.status));
    err.status = r.status;
    throw err;
  }
}

/**
 * Ejecuta una consulta DAX y devuelve sus filas ya aplanadas.
 * Las claves vienen como `Tabla[Columna]` o `[Medida]`; se recortan a la
 * última parte para que el resto del backend trabaje con nombres simples.
 */
async function consultar(workspaceId, datasetId, dax) {
  return (await pedir(workspaceId, datasetId, [dax]))[0];
}

/**
 * Execute Queries no devuelve el error en `error.message` sino enterrado en
 * `error["pbi.error"].details[]`, con los nombres envueltos en <oii>. Sin
 * desenterrarlo, al usuario le llega un JSON de cuatro renglones donde lo
 * único que importa es «falta tal columna en tal tabla».
 */
function mensajeDeError(texto, status) {
  let j;
  try { j = JSON.parse(texto); } catch (e) { return "respondió " + status + ": " + texto.slice(0, 300); }
  const e = j.error || {};
  const pbi = e["pbi.error"] || {};
  const det = (pbi.details || []).find((d) => d.code === "DetailsMessage");
  const crudo = (det && det.detail && det.detail.value) || e.message || pbi.code || e.code;
  if (!crudo) return "respondió " + status;
  return String(crudo)
    .replace(/<\/?oii>/g, "")          // marcas de "objeto identificable"
    .replace(/^Query \((\d+), (\d+)\)\s*/, "")  // la posición no le dice nada a nadie
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarClaves(fila) {
  const salida = {};
  for (const [k, v] of Object.entries(fila)) {
    const m = k.match(/\[([^\]]+)\]\s*$/);
    salida[m ? m[1] : k] = v;
  }
  return salida;
}

/**
 * Varias consultas del mismo informe, agrupadas en pocos pedidos.
 *
 * Si una tanda falla, se reintenta consulta por consulta: así un EVALUATE
 * roto no se lleva puestos a los otros siete, y el error que sale nombra al
 * culpable en vez de a la tanda entera.
 */
async function consultarVarias(workspaceId, datasetId, consultas) {
  const claves = Object.keys(consultas).filter((k) => consultas[k]);
  const tandas = [];
  for (let i = 0; i < claves.length; i += POR_TANDA) tandas.push(claves.slice(i, i + POR_TANDA));

  const salida = {};
  await Promise.all(tandas.map(async (tanda) => {
    try {
      const res = await pedir(workspaceId, datasetId, tanda.map((k) => consultas[k]));
      tanda.forEach((k, i) => { salida[k] = res[i]; });
    } catch (e) {
      if (e.status === 429) throw e;          // si es caudal, no insistir de a una
      console.warn("[powerbi] tanda de " + tanda.length + " falló; voy de a una: " + e.message);
      for (const k of tanda) salida[k] = await consultar(workspaceId, datasetId, consultas[k]);
    }
  }));
  return salida;
}

/** GET a la REST API de Power BI (metadatos: workspaces, modelos, reportes). */
async function rest(ruta) {
  const token = await obtenerToken();
  const r = await fetch(BASE + ruta, { headers: { Authorization: "Bearer " + token } });
  const texto = await r.text();
  if (!r.ok) {
    let detalle = texto.slice(0, 300);
    try { detalle = (JSON.parse(texto).error || {}).message || detalle; } catch (e) { /* texto plano */ }
    const err = new Error("Power BI respondió " + r.status + ": " + detalle);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(texto);
}

module.exports = { consultar, consultarVarias, rest, mensajeDeError, GUID };
