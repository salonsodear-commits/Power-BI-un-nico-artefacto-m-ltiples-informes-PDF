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
const { GUID } = require("./powerbi/client");

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

// el artefacto, servido desde el mismo origen: así "Actualizar datos" funciona
app.use(express.static(path.join(__dirname, "..", "artefacto")));

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

  const workspaceId = cuerpo.workspaceId || process.env.POWERBI_WORKSPACE_ID;
  const datasetId = cuerpo.datasetId || process.env.POWERBI_DATASET_ID;
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
    res.json({
      meta: {
        organizacion: process.env.ORGANIZACION || "Informe de gestión",
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

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log("Backend de informes escuchando en http://localhost:" + PORT);
  console.log("Artefacto:      http://localhost:" + PORT + "/informes-powerbi.html");
  console.log("Informes:       " + Object.keys(INFORMES).join(", "));
});
