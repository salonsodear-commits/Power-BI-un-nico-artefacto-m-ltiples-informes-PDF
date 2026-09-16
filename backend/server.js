"use strict";
/**
 * Intermediario entre el artefacto y Power BI.
 *
 * El artefacto nunca ve credenciales: manda qué informe quiere y contra qué
 * tablero, y recibe el JSON normalizado ya listo para dibujar.
 * (Manual, pasos 6, 14 y 20.)
 */
const ENTORNO = require("./entorno");
const path = require("path");
const express = require("express");
const INFORMES = require("./informes");
const { consultar, GUID } = require("./powerbi/client");
const DESCUBRIR = require("./powerbi/descubrir");
const DETECTAR = require("./powerbi/detectar");
const AUTH = require("./powerbi/auth");
const SESIONES = require("./sesiones");
const MODELO = require("./modelo");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);   // para saber si la conexión llegó por https
app.use(express.json({ limit: "32kb" }));
// Cada navegador, su propia sesión: sin esto, dos personas en el mismo backend
// compartirían el token y el RLS del modelo dejaría de aplicarse.
app.use(SESIONES.middleware);

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Credentials", "true");
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
       .json({ error: e.message, necesitaIngreso: !!e.necesitaIngreso });
  }
};

/* ══ sesión ════════════════════════════════════════════════════════════
   En modo delegado entra el usuario con su propia cuenta: la API lo ve con
   los permisos que ya tiene en Power BI, sin depender de un administrador. */

app.get("/api/auth", (_req, res) => {
  const a = AUTH.estado();
  if (a.faltan && a.faltan.length) a.diagnostico = ENTORNO.diagnostico(a.faltan);
  res.json(a);
});

app.post("/api/auth/ingresar", atajo(async () => {
  if (AUTH.modo() === "servicio") {
    throw Object.assign(new Error(
      "El backend está en modo Service Principal. Quitá CLIENT_SECRET de .env " +
      "(o poné AUTH_MODO=delegado) para entrar con tu cuenta."), { status: 400 });
  }
  const i = await AUTH.iniciarIngreso();
  return { ...i, estado: AUTH.estado() };
}));

app.post("/api/auth/salir", (_req, res) => { AUTH.borrarSesion(); res.json(AUTH.estado()); });

app.get("/api/powerbi/workspaces", atajo(async () => ({
  workspaces: await DESCUBRIR.workspaces(),
  nota: "Con Service Principal sólo aparecen los workspaces donde el " +
        "administrador agregó la aplicación."
})));

app.get("/api/powerbi/workspaces/:ws/modelos", atajo(async (req) => ({
  modelos: await DESCUBRIR.modelos(req.params.ws)
})));

app.get("/api/powerbi/workspaces/:ws/reportes/:id", atajo(async (req) =>
  DESCUBRIR.reporte(req.params.ws, req.params.id)));

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

/**
 * Deduce el mapeo probando nombres habituales contra el modelo. Tarda,
 * porque son decenas de consultas, pero evita que alguien tenga que
 * escribir a mano cómo se llama cada medida.
 */
app.post("/api/powerbi/detectar", atajo(async (req) => {
  const guardado = MODELO.leer();
  const ws = (req.body && req.body.workspaceId) || guardado.workspaceId || process.env.POWERBI_WORKSPACE_ID;
  const ds = (req.body && req.body.datasetId) || guardado.datasetId || process.env.POWERBI_DATASET_ID;
  if (!GUID.test(ws || "") || !GUID.test(ds || "")) {
    throw Object.assign(new Error("Elegí antes el workspace y el modelo."), { status: 400 });
  }
  return DETECTAR.detectar(ws, ds);
}));

/* ══ mapeo del modelo ══════════════════════════════════════════════════ */

/** Vuelve a la semilla versionada: es la salida cuando el mapeo local quedó viejo. */
app.post("/api/modelo/reiniciar", (_req, res) => {
  try {
    res.json({ modelo: MODELO.reiniciar(), resumen: MODELO.resumen() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/modelo", (_req, res) => {
  res.json({ campos: MODELO.CAMPOS, modelo: MODELO.leer(), ejemplo: MODELO.POR_DEFECTO });
});

app.put("/api/modelo", (req, res) => {
  try { res.json({ modelo: MODELO.guardar(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/modelo/verificar", atajo(async (req) => {
  const m = MODELO.normalizar(req.body && req.body.modelo ? req.body.modelo : MODELO.leer());
  const g = MODELO.leer();
  const ws = (req.body && req.body.workspaceId) || m.workspaceId || g.workspaceId ||
             process.env.POWERBI_WORKSPACE_ID;
  const ds = (req.body && req.body.datasetId) || m.datasetId || g.datasetId ||
             process.env.POWERBI_DATASET_ID;
  // Sin tablero, las 21 consultas fallan por la conexión y no por las
  // referencias: dar ese resultado por bueno marcaría el mapeo entero como roto.
  if (!GUID.test(ws || "") || !GUID.test(ds || "")) {
    const e = new Error("Elegí antes el workspace y el modelo semántico en la pestaña Tablero: " +
                        "sin eso no hay contra qué probar las referencias.");
    e.status = 400;
    throw e;
  }
  const refs = {};
  for (const [k, v] of Object.entries(m.medidas)) if (v) refs["medidas." + k] = v;
  for (const [k, v] of Object.entries(m.columnas)) if (v) refs["columnas." + k] = v;
  const r = await DESCUBRIR.verificar(ws, ds, refs);
  const malas = Object.values(r).filter((x) => x.estado === "error").length;
  // El veredicto queda anotado: es lo que hace que /api/informes deje de
  // ofrecer un informe cuyo modelo no tiene las medidas que necesita. Sólo
  // para los campos que se probaron tal cual están guardados: el formulario
  // puede tener ediciones sin guardar, y ese veredicto no es del modelo en uso.
  MODELO.marcar(Object.fromEntries(
    Object.entries(r)
      .filter(([, x]) => x.estado !== "sin-mapear")
      .filter(([k]) => { const [gr, c] = k.split("."); return g[gr][c] === m[gr][c]; })
      // un timeout o un 401 no dicen nada sobre la referencia: sólo cuenta
      // como rota la que el modelo contestó que no conoce
      .filter(([, x]) => x.estado === "ok" || esReferenciaInexistente(x.mensaje))
      .map(([k, x]) => [k, x.estado === "error"])));
  // si la columna de período existe, de paso se averigua de qué tipo es
  const periodo = r["columnas.periodo"] && r["columnas.periodo"].estado === "ok"
    ? await DESCUBRIR.formatoPeriodo(ws, ds, m.columnas.periodo)
    : null;
  return { resultado: r, ok: malas === 0, conError: malas, periodo };
}));

/**
 * Además del catálogo, qué informes puede dar el mapeo actual. Sin esto el
 * artefacto deja elegir uno que el modelo no soporta y el fallo aparece
 * recién como un error de Power BI, que no dice qué hacer.
 */
app.get("/api/informes", (_req, res) => {
  res.json(Object.entries(INFORMES).map(([clave, i]) => {
    const faltan = loQueFalta(i);
    return {
      clave, ...i.meta,
      disponible: faltan.length === 0,
      faltan: faltan.map((f) => f.texto),
      // "roto" = está escrito pero el modelo lo rechazó · "sin-mapear" = vacío
      motivo: faltan.some((f) => f.roto) ? "roto" : (faltan.length ? "sin-mapear" : null),
      // la primera casilla a corregir, para que el artefacto abra ahí
      primero: faltan.length ? { grupo: faltan[0].grupo, clave: faltan[0].clave } : null
    };
  }));
});

/**
 * Qué le falta a un informe para poder salir. Un campo escrito pero que el
 * modelo semántico rechazó cuenta igual que uno vacío: lo contrario es ofrecer
 * un informe que después explota con un error de Power BI.
 */
function loQueFalta(informe) {
  const m = MODELO.leer();
  const req = informe.requiere || { medidas: [], columnas: [] };
  const falta = [];
  for (const grupo of ["medidas", "columnas"]) {
    for (const clave of req[grupo] || []) {
      const nombre = rotulo(grupo, clave);
      if (!m[grupo][clave]) falta.push({ grupo, clave, texto: nombre });
      else if (m.rotos.includes(grupo + "." + clave)) {
        falta.push({ grupo, clave, roto: true, ref: m[grupo][clave],
                     texto: nombre + " (" + m[grupo][clave] + " no existe en el modelo)" });
      }
    }
  }
  return falta;
}

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
      const faltan = loQueFalta(informe).map((f) => f.texto);
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
    const culpa = campoCulpable(e.message, guardado);
    // anotarlo acá es lo que evita el segundo fallo idéntico: la próxima vez
    // el informe ya sale sin ese campo, o el catálogo avisa que no se puede
    if (culpa) MODELO.marcar({ [culpa.grupo + "." + culpa.clave]: true });
    res.status(e.status && e.status >= 400 && e.status < 500 ? e.status : 502)
       .json({ error: e.message, necesitaIngreso: !!e.necesitaIngreso,
               campo: culpa || undefined });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "No existe " + req.method + " " + req.path,
    rutas: ["GET /", "GET /api/informes", "POST /api/informe",
            "GET /api/auth", "POST /api/auth/ingresar", "POST /api/auth/salir",
            "GET /api/powerbi/workspaces", "GET /api/powerbi/workspaces/:ws/modelos",
            "GET /api/powerbi/workspaces/:ws/reportes/:id",
            "GET /api/powerbi/modelos/:ws/:ds/medidas", "POST /api/powerbi/dax", "POST /api/powerbi/detectar",
            "GET /api/modelo", "PUT /api/modelo", "POST /api/modelo/verificar",
            "POST /api/modelo/reiniciar"]
  });
});

/**
 * Power BI nombra la referencia que no pudo resolver; acá se busca cuál de los
 * campos mapeados la contiene. Sin esto, "The value for 'BO' cannot be
 * determined" no dice en qué casilla del formulario está el problema.
 */
/**
 * ¿Este error dice que una referencia no existe? Un timeout, un 401 o un límite
 * de filas también nombran tablas, y ahí culpar a un campo sería mentir.
 */
const esReferenciaInexistente = (mensaje) =>
  /cannot be determined|cannot be found|Cannot find table or measure|couldn't be found|no puede encontrar/i
    .test(String(mensaje || ""));

function campoCulpable(mensaje, modelo) {
  const texto = String(mensaje || "");
  if (!esReferenciaInexistente(texto)) return null;
  for (const grupo of ["medidas", "columnas"]) {
    for (const [clave, ref] of Object.entries(modelo[grupo] || {})) {
      if (!ref) continue;
      // el nombre desnudo: [BO] → BO · Tabla[Col] → Col · MIN(T[C]) → C
      const m = String(ref).match(/\[([^\]]+)\]\s*\)?$/);
      const nombre = m ? m[1] : ref;
      if (!nombre) continue;
      const esc = nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Power BI lo nombra entre comillas o entre corchetes, según el error
      if (new RegExp("['\"\u2018\u2019\\[]" + esc + "['\"\u2018\u2019\\]]").test(texto)) {
        return { grupo, clave, ref, rotulo: rotulo(grupo, clave) };
      }
    }
  }
  return null;
}

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
  const mp = MODELO.resumen();
  console.log("Mapeo:      " + mp.medidas + " medidas y " + mp.columnas +
    " columnas · de " + mp.origen);

  // Fuera de un pedido no hay persona: en modo delegado se informa el conjunto.
  const a = AUTH.estado();
  if (a.modo === "delegado") {
    console.log("Sesiones:   " + a.sesionesAbiertas + " abierta(s) · cada quien entra con su cuenta");
  } else {
    console.log("Sesión:     Service Principal" + (a.conectado ? " · configurado" : " · incompleto"));
  }
  if (a.faltan && a.faltan.length) {
    console.log("\n── Falta configurar " + a.faltan.join(" y ") + " ──");
    for (const l of ENTORNO.diagnostico(a.faltan)) console.log("  " + l);
  } else if (a.modo === "delegado") {
    console.log("\nCada persona entra desde Conectar → Entrar con mi cuenta.");
    console.log("No hace falta un administrador: la API los ve con sus propios permisos.");
  }
  console.log("Sin entrar, el artefacto igual funciona con Datos de ejemplo y Pegar JSON.");
});
