"use strict";
/**
 * Intermediario entre el artefacto y Power BI.
 *
 * El artefacto nunca ve credenciales: manda qué informe quiere y contra qué
 * tablero, y recibe el JSON normalizado ya listo para dibujar.
 * (Manual, pasos 6, 14 y 20.)
 */
require("dotenv").config();
const path = require("path");
const express = require("express");
const INFORMES = require("./informes");
const { consultar, GUID } = require("./powerbi/client");
const DESCUBRIR = require("./powerbi/descubrir");
const MODELO = require("./modelo");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// Si servís el artefacto desde acá no hace falta CORS. Si lo abrís desde otro
// origen, listá ese origen en ORIGENES_PERMITIDOS: nunca "*" para un backend
// que habla con datos corporativos.
const PERMITIDOS = (process.env.ORIGENES_PERMITIDOS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origen = req.headers.origin;
  if (origen && PERMITIDOS.includes(origen)) {
    res.setHeader("Access-Control-Allow-Origin", origen);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// El artefacto, servido desde el mismo origen: así "Actualizar datos" funciona.
// `index` hace que la raíz abra el artefacto — es lo que abre un puerto
// reenviado de Codespaces, y lo que uno espera al entrar a localhost:3000.
app.use(express.static(path.join(__dirname, "..", "artefacto"), {
  index: "informes-powerbi.html"
}));

/* ══ vínculo con Power BI ══════════════════════════════════════════════
   Descubrir qué ve esta identidad, probar DAX y mapear el modelo. Es lo
   que permite apuntar el generador a un tablero sin tocar código. */

const atajo = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    console.error("[powerbi]", e.message);
    res.status(e.status && e.status >= 400 && e.status < 500 ? e.status : 502)
       .json({ error: e.message });
  }
};

app.get("/api/powerbi/workspaces", atajo(async () => ({
  workspaces: await DESCUBRIR.workspaces(),
  nota: "Con Service Principal sólo aparecen los workspaces donde el " +
        "administrador agregó la aplicación."
})));

app.get("/api/powerbi/workspaces/:ws/modelos", atajo(async (req) => ({
  modelos: await DESCUBRIR.modelos(req.params.ws)
})));

app.get("/api/powerbi/modelos/:ws/:ds/medidas", atajo(async (req) =>
  DESCUBRIR.medidas(req.params.ws, req.params.ds)));

// Consola DAX: sólo lectura, pero deja leer todo el modelo. Se apaga en
// producción salvo que se pida explícitamente con CONSOLA_DAX=1.
const CONSOLA_DAX = process.env.CONSOLA_DAX
  ? process.env.CONSOLA_DAX === "1"
  : process.env.NODE_ENV !== "production";

app.post("/api/powerbi/dax", atajo(async (req) => {
  if (!CONSOLA_DAX) {
    const e = new Error("La consola DAX está apagada. Activala con CONSOLA_DAX=1.");
    e.status = 403; throw e;
  }
  const { workspaceId, datasetId, dax } = req.body || {};
  if (typeof dax !== "string" || !dax.trim()) throw Object.assign(new Error("Falta la consulta DAX"), { status: 400 });
  if (dax.length > 8000) throw Object.assign(new Error("La consulta es demasiado larga"), { status: 400 });
  const filas = await consultar(workspaceId, datasetId, dax);
  return { filas: filas.slice(0, 200), total: filas.length,
           columnas: filas.length ? Object.keys(filas[0]) : [] };
}));

/* ══ mapeo del modelo ══════════════════════════════════════════════════ */

app.get("/api/modelo", (_req, res) => {
  res.json({ campos: MODELO.CAMPOS, modelo: MODELO.leer(), ejemplo: MODELO.POR_DEFECTO });
});

app.put("/api/modelo", (req, res) => {
  try { res.json({ modelo: MODELO.guardar(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/modelo/verificar", atajo(async (req) => {
  const m = MODELO.normalizar(req.body && req.body.modelo ? req.body.modelo : MODELO.leer());
  const ws = (req.body && req.body.workspaceId) || m.workspaceId || process.env.POWERBI_WORKSPACE_ID;
  const ds = (req.body && req.body.datasetId) || m.datasetId || process.env.POWERBI_DATASET_ID;
  const refs = {};
  for (const [k, v] of Object.entries(m.medidas)) if (v) refs["medidas." + k] = v;
  for (const [k, v] of Object.entries(m.columnas)) if (v) refs["columnas." + k] = v;
  const r = await DESCUBRIR.verificar(ws, ds, refs);
  const malas = Object.values(r).filter((x) => x.estado === "error").length;
  return { resultado: r, ok: malas === 0, conError: malas };
}));

app.get("/api/informes", (_req, res) => {
  res.json(Object.entries(INFORMES).map(([clave, i]) => ({ clave, ...i.meta })));
});

app.post("/api/informe", async (req, res) => {
  const cuerpo = req.body || {};
  const informe = INFORMES[cuerpo.reportType];
  if (!informe) {
    return res.status(400).json({
      error: "Tipo de informe desconocido",
      disponibles: Object.keys(INFORMES)
    });
  }

  const guardado = MODELO.leer();
  const workspaceId = cuerpo.workspaceId || guardado.workspaceId || process.env.POWERBI_WORKSPACE_ID;
  const datasetId = cuerpo.datasetId || guardado.datasetId || process.env.POWERBI_DATASET_ID;
  if (!GUID.test(workspaceId || "") || !GUID.test(datasetId || "")) {
    return res.status(400).json({
      error: "Indicá el Workspace ID y el Dataset ID del tablero (ambos GUID)"
    });
  }

  const filtros = cuerpo.filtros || {};
  const p = {
    workspaceId, datasetId,
    periodo: cuerpo.periodo,
    sociedad: filtros.sociedad,
    vertical: filtros.vertical
  };

  try {
    const secciones = await informe.construir(p);
    if (!secciones.length) {
      const req = informe.requiere || { medidas: [], columnas: [] };
      const faltan = [
        ...req.medidas.filter((k) => !guardado.medidas[k]).map((k) => rotulo("medidas", k)),
        ...req.columnas.filter((k) => !guardado.columnas[k]).map((k) => rotulo("columnas", k))
      ];
      return res.status(422).json({
        error: "El informe " + informe.meta.nombre + " no tiene nada que mostrar con este mapeo.",
        faltan,
        sugerencia: faltan.length
          ? "Mapeá estos campos en Conectar → Mapeo: " + faltan.join(", ")
          : "Las medidas están mapeadas pero el modelo no devolvió filas para el período elegido."
      });
    }
    res.json({
      meta: {
        organizacion: guardado.organizacion || process.env.ORGANIZACION || "Informe de gestión",
        informe: cuerpo.reportType,
        titulo: informe.meta.titulo,
        bajada: informe.meta.bajada,
        fuente: informe.meta.fuente,
        periodo: p.periodo,
        filtros: { sociedad: p.sociedad || "Todas", vertical: p.vertical || "Todas" },
        unidad: "millones de $",
        escala: 1e6,
        workspaceId, datasetId,
        actualizado: new Date().toISOString()
      },
      secciones
    });
  } catch (e) {
    // el mensaje de Power BI se devuelve tal cual; las credenciales nunca salen de acá
    console.error("[informe]", cuerpo.reportType, e.message);
    res.status(e.status && e.status >= 400 && e.status < 500 ? e.status : 502)
       .json({ error: e.message });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "No existe " + req.method + " " + req.path,
    rutas: ["GET /", "GET /api/informes", "POST /api/informe",
            "GET /api/powerbi/workspaces", "GET /api/powerbi/workspaces/:ws/modelos",
            "GET /api/powerbi/modelos/:ws/:ds/medidas", "POST /api/powerbi/dax",
            "GET /api/modelo", "PUT /api/modelo", "POST /api/modelo/verificar"]
  });
});

/** Rótulo legible de un campo del mapeo, para los mensajes de error. */
function rotulo(grupo, clave) {
  const c = (MODELO.CAMPOS[grupo] || []).find((x) => x.clave === clave);
  return c ? c.rotulo : clave;
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log("Backend de informes escuchando en http://localhost:" + PORT);
  console.log("Artefacto:  http://localhost:" + PORT + "/");
  console.log("Informes:   " + Object.keys(INFORMES).join(", "));

  // Sin credenciales el servidor igual sirve el artefacto: se puede trabajar
  // con Datos de ejemplo o Pegar JSON. Sólo "Actualizar datos" necesita .env.
  const faltan = ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET"].filter((k) => !process.env[k]);
  if (faltan.length) {
    console.log("\nFalta configurar " + faltan.join(", ") + " en backend/.env");
    console.log("  cp backend/.env.example backend/.env   y completalo");
    console.log("Mientras tanto el artefacto funciona con Datos de ejemplo y Pegar JSON.");
  }
});
