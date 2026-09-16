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

/**
 * Ejecuta una consulta DAX y devuelve sus filas ya aplanadas.
 * Las claves vienen como `Tabla[Columna]` o `[Medida]`; se recortan a la
 * última parte para que el resto del backend trabaje con nombres simples.
 */
async function consultar(workspaceId, datasetId, dax) {
  if (!GUID.test(workspaceId || "")) throw new Error("workspaceId no es un GUID válido");
  if (!GUID.test(datasetId || "")) throw new Error("datasetId no es un GUID válido");

  const token = await obtenerToken();
  const r = await fetch(`${BASE}/groups/${workspaceId}/datasets/${datasetId}/executeQueries`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true }
    })
  });

  const texto = await r.text();
  if (!r.ok) {
    const err = new Error("Power BI: " + mensajeDeError(texto, r.status));
    err.status = r.status;
    throw err;
  }

  const j = JSON.parse(texto);
  const filas = (((j.results || [])[0] || {}).tables || [])[0];
  return (filas && filas.rows ? filas.rows : []).map(normalizarClaves);
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

/** Varias consultas del mismo informe, en paralelo. */
function consultarVarias(workspaceId, datasetId, consultas) {
  const claves = Object.keys(consultas);
  return Promise.all(claves.map((k) => consultar(workspaceId, datasetId, consultas[k])))
    .then((res) => Object.fromEntries(claves.map((k, i) => [k, res[i]])));
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
