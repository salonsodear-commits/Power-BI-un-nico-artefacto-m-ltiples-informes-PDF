"use strict";
/**
 * Descubrimiento del tenant: qué workspaces y qué modelos semánticos ve esta
 * identidad, y qué medidas tiene un modelo.
 *
 * Con Service Principal, GET /groups devuelve SOLO los workspaces donde al
 * administrador lo agregó explícitamente. Un listado vacío casi siempre
 * significa eso, no que no haya workspaces.
 */
const { consultar, rest, GUID } = require("./client");

async function workspaces() {
  const j = await rest("/groups");
  return (j.value || []).map((w) => ({
    id: w.id, nombre: w.name,
    soloLectura: !!w.isReadOnly, capacidad: !!w.isOnDedicatedCapacity
  }));
}

async function modelos(workspaceId) {
  if (!GUID.test(workspaceId || "")) throw new Error("workspaceId no es un GUID válido");
  const [ds, rp] = await Promise.all([
    rest(`/groups/${workspaceId}/datasets`),
    rest(`/groups/${workspaceId}/reports`).catch(() => ({ value: [] }))
  ]);
  const reportes = rp.value || [];
  return (ds.value || []).map((d) => ({
    id: d.id, nombre: d.name,
    actualizable: !!d.isRefreshable,
    // qué reportes se apoyan en este modelo: ayuda a reconocer "el tablero"
    reportes: reportes.filter((r) => r.datasetId === d.id).map((r) => r.name)
  }));
}

/**
 * De un reporte al modelo que lo alimenta. Es el atajo para cuando uno copia
 * la URL del tablero abierto, que lleva el reportId pero no el datasetId.
 */
async function reporte(workspaceId, reportId) {
  if (!GUID.test(workspaceId || "")) throw new Error("workspaceId no es un GUID válido");
  if (!GUID.test(reportId || "")) throw new Error("reportId no es un GUID válido");
  const r = await rest(`/groups/${workspaceId}/reports/${reportId}`);
  if (!r.datasetId) throw new Error("Ese reporte no declara un modelo semántico.");
  let nombreModelo = null;
  try {
    const ds = await rest(`/groups/${workspaceId}/datasets/${r.datasetId}`);
    nombreModelo = ds.name || null;
  } catch (e) { /* el nombre es un lujo; el ID es lo que importa */ }
  return { id: r.id, nombre: r.name, datasetId: r.datasetId, nombreModelo };
}

/**
 * Medidas del modelo.
 *
 * Las funciones INFO de DAX no están soportadas por el endpoint clásico
 * executeQueries (sí por el nuevo Execute DAX Queries, que responde en Arrow).
 * Se intentan igual, porque en los modelos donde funcionan ahorran todo el
 * trabajo manual; si fallan, se devuelve `soportado:false` y el artefacto
 * ofrece la consola DAX y el mapeo a mano.
 */
async function medidas(workspaceId, datasetId) {
  const intentos = [
    { dax: "EVALUATE INFO.VIEW.MEASURES()", nombre: "Name", tabla: "Table", expr: "Expression" },
    { dax: "EVALUATE INFO.MEASURES()", nombre: "Name", tabla: "TableID", expr: "Expression" }
  ];
  const motivos = [];
  for (const i of intentos) {
    try {
      const filas = await consultar(workspaceId, datasetId, i.dax);
      if (!filas.length) continue;
      return {
        soportado: true,
        via: i.dax,
        medidas: filas.map((f) => ({
          nombre: f[i.nombre], tabla: f[i.tabla],
          expresion: typeof f[i.expr] === "string" ? f[i.expr].slice(0, 400) : undefined
        })).filter((m) => m.nombre).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), "es"))
      };
    } catch (e) { motivos.push(i.dax + " → " + e.message); }
  }
  return {
    soportado: false,
    medidas: [],
    motivo: "Este modelo no responde a las funciones INFO por executeQueries. " +
            "Usá la consola DAX para probar nombres y completá el mapeo a mano.",
    detalle: motivos
  };
}

/**
 * ¿Existe cada referencia mapeada? Se prueba una por una con un EVALUATE
 * mínimo: es la forma que funciona en cualquier modelo, con o sin INFO.
 */
async function verificar(workspaceId, datasetId, refs) {
  const resultado = {};
  for (const [clave, ref] of Object.entries(refs)) {
    if (!ref) { resultado[clave] = { estado: "sin-mapear" }; continue; }
    const dax = ref.startsWith("[")
      ? `EVALUATE ROW("v", ${ref})`
      : `EVALUATE TOPN(1, SUMMARIZECOLUMNS(${ref}))`;
    try {
      await consultar(workspaceId, datasetId, dax);
      resultado[clave] = { estado: "ok" };
    } catch (e) {
      resultado[clave] = { estado: "error", mensaje: recortar(e.message) };
    }
  }
  return resultado;
}

const recortar = (m) => String(m).replace(/\s+/g, " ").slice(0, 200);

module.exports = { workspaces, modelos, reporte, medidas, verificar };
