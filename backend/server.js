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
const CONTEXTO = require("./powerbi/contexto");
const EXCLUSIONES = require("./powerbi/exclusiones");
const SEMANTICA = require("./powerbi/semantica");
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
  return DETECTAR.detectar(ws, ds, medidasDelInformeActivo());
}));

/**
 * Qué filtros trae puesto el tablero. Lo que Power Query ya dejó recortado
 * —una sola sociedad, un solo canal— se muestra como contexto en vez de
 * pedirse otra vez: el panel sólo ofrece las dimensiones que de verdad tienen
 * más de un valor.
 */
/**
 * ¿El mapeo guardado sirve para ESTE tablero?
 *
 * Apuntar a otro modelo —o a la v4 de uno que cambió nombres— deja el mapeo
 * viejo apuntando a columnas que ya no existen, y el informe sale vacío o a
 * medias. Acá se prueba, y si no cierra se detecta solo.
 */
app.post("/api/tablero/:ws/:ds/ajustar", atajo(async (req) => {
  const { ws, ds } = req.params;
  if (!GUID.test(ws) || !GUID.test(ds)) {
    throw Object.assign(new Error("Workspace y modelo deben ser GUID"), { status: 400 });
  }
  const antes = MODELO.leer();
  const otroTablero = !!antes.datasetId && antes.datasetId !== ds;

  /* El inventario de ESTE tablero. Es una sola consulta y es lo que permite
     podar después: sin él no hay forma barata de saber si una referencia
     guardada existe acá. */
  let tablas = null;
  try { tablas = await SEMANTICA.inventario(ws, ds); }
  catch (e) { /* el modelo no deja; se sigue sin poda */ }

  /* ── el mismo tablero: quizá el mapeo guardado ya sirve ───────────── */
  let malas = 0;
  if (!otroTablero) {
    const informe = INFORMES[informeQueCorresponde()] || {};
    const claves = [
      ...((informe.requiere || {}).medidas || []).map((k) => ["medidas", k]),
      ...((informe.requiere || {}).columnas || []).map((k) => ["columnas", k]),
      ["columnas", "periodo"], ["columnas", "clienteNombre"], ["columnas", "agingTramo"]
    ];
    const refs = {};
    for (const [g, k] of claves) if (antes[g][k]) refs[g + "." + k] = antes[g][k];
    if (Object.keys(refs).length) {
      const r = await DESCUBRIR.verificar(ws, ds, refs);
      malas = Object.values(r).filter((x) => x.estado === "error").length;
      MODELO.marcar(Object.fromEntries(Object.entries(r)
        .filter(([, x]) => x.estado !== "sin-mapear")
        .map(([k, x]) => [k, x.estado === "error"])));
    }
    // sirve, pero igual se poda: puede haber columnas nunca verificadas que
    // quedaron de una versión anterior del mismo modelo
    if (Object.keys(refs).length && !malas) {
      const podadas = podar(MODELO.leer(), tablas);
      if (podadas.cuantas) MODELO.guardar(podadas.modelo);
      return { ajustado: podadas.cuantas > 0, malas: 0, podadas: podadas.cuantas,
               motivo: podadas.cuantas
                 ? "el mapeo sirve, salvo " + podadas.cuantas + " referencia(s) que ya no existen"
                 : "el mapeo guardado sirve para este tablero",
               resumen: MODELO.resumen() };
    }
  }

  /* ── detectar contra este tablero ─────────────────────────────────── */
  const d = await DETECTAR.detectar(ws, ds, medidasParaDetectar(otroTablero));
  const prop = d.propuesta || { medidas: {}, columnas: {} };

  /* De qué se parte. Si es OTRO tablero, de cero: heredar el mapeo anterior
     dejaba veintiséis columnas apuntando a tablas que este modelo no tiene, y
     el informe fallaba con «Cannot find table 'Aging - Actualizado'». Si es el
     mismo, se conserva lo que anda y sólo se repone lo roto. */
  const propuesto = {
    ...antes, workspaceId: ws, datasetId: ds,
    medidas: otroTablero ? {} : { ...antes.medidas },
    columnas: otroTablero ? {} : { ...antes.columnas },
    periodoFormato: prop.periodoFormato || antes.periodoFormato
  };

  let puestas = 0, vaciadas = 0;
  for (const grupo of ["medidas", "columnas"]) {
    for (const [k, v] of Object.entries(prop[grupo] || {})) {
      const roto = (antes.rotos || []).includes(grupo + "." + k);
      if (v && propuesto[grupo][k] !== v) {
        // lo detectado gana sobre lo roto; sobre lo que anda, sólo si faltaba
        if (otroTablero || roto || !propuesto[grupo][k]) { propuesto[grupo][k] = v; puestas++; }
      } else if (!v && roto && propuesto[grupo][k]) {
        // no se encontró y estaba roto: mejor vacío que una consulta que falla
        propuesto[grupo][k] = ""; vaciadas++;
      }
    }
  }
  propuesto.rotos = [];

  /* Las exclusiones y los filtros por defecto son de UN tablero: «sólo el
     canal Corporaciones, sociedad IHSA, estas clases de documento» no
     significa nada en otro modelo. Arrastrarlas filtraba el nuevo por valores
     de otro —en silencio, porque en DAX filtrar por un valor que no existe no
     es un error sino cero filas.

     Pero tampoco se tiran: se guardan bajo el tablero al que pertenecen y se
     reponen al volver. Irse y volver dejaba el informe de deuda sin sus cinco
     exclusiones y con los totales cambiados, sin que nadie lo pidiera. */
  const heredadas = (antes.exclusiones || []).length +
                    Object.keys(antes.filtrosPorDefecto || {}).length;
  let repuestas = 0;
  if (otroTablero) {
    propuesto.porTablero = { ...(antes.porTablero || {}) };
    if (heredadas) {
      propuesto.porTablero[antes.datasetId] = {
        exclusiones: antes.exclusiones || [],
        filtrosPorDefecto: antes.filtrosPorDefecto || {}
      };
    }
    const guardadas = propuesto.porTablero[ds];
    propuesto.exclusiones = (guardadas || {}).exclusiones || [];
    propuesto.filtrosPorDefecto = (guardadas || {}).filtrosPorDefecto || {};
    repuestas = propuesto.exclusiones.length +
                Object.keys(propuesto.filtrosPorDefecto).length;
  }

  const podadas = podar(MODELO.normalizar(propuesto), tablas);
  MODELO.guardar(podadas.modelo);

  const notas = [];
  if (otroTablero) notas.push("es otro tablero: el mapeo se rehízo desde cero");
  else notas.push(malas + " referencia(s) del mapeo no existen en este tablero; se detectó de nuevo");
  if (otroTablero && heredadas) {
    notas.push("se guardaron " + heredadas + " exclusión/filtro del tablero anterior");
  }
  if (repuestas) notas.push("se repusieron " + repuestas + " de este tablero");
  if (podadas.cuantas) notas.push(podadas.cuantas + " referencia(s) se vaciaron por no existir acá");

  return { ajustado: true, puestas, vaciadas, malas, frenado: !!d.frenado,
           via: d.via, otroTablero,
           // lo que el Power Query de ESTE tablero ya dejó recortado
           yaFiltrado: d.yaFiltrado || [],
           soltadas: otroTablero ? heredadas : 0,
           repuestas,
           podadas: podadas.cuantas,
           motivo: notas.join("; "),
           resumen: MODELO.resumen() };
}));

/**
 * Vacía las referencias que este modelo no tiene.
 *
 * Verificar una por una cuesta una consulta cada una, así que el ajuste sólo
 * comprobaba las que el informe declara imprescindibles: media docena. Las
 * otras veinte sobrevivían apuntando a tablas de otro tablero. Con el
 * inventario en la mano la comprobación es gratis y alcanza a todas.
 *
 * Sólo columnas: las medidas no figuran en el inventario, y las que quedaron
 * son las que la detección confirmó probándolas.
 */
function podar(modelo, tablas) {
  if (!tablas || !Object.keys(tablas).length) return { modelo, cuantas: 0 };
  const existe = new Set();
  for (const t of Object.values(tablas)) for (const c of t.columnas || []) existe.add(c.ref);

  const columnas = { ...modelo.columnas };
  let cuantas = 0;
  for (const [k, ref] of Object.entries(columnas)) {
    if (!ref || existe.has(ref)) continue;
    columnas[k] = ""; cuantas++;
  }
  if (!cuantas) return { modelo, cuantas: 0 };

  // una exclusión o un filtro fijo sobre una columna que se cayó, se cae
  const exclusiones = (modelo.exclusiones || []).filter((r) =>
    [r.campo, r.texto, ...(r.campos || [])].filter(Boolean).every((k) => columnas[k]));
  const filtrosPorDefecto = Object.fromEntries(
    Object.entries(modelo.filtrosPorDefecto || {}).filter(([k]) => columnas[k]));

  return { modelo: { ...modelo, columnas, exclusiones, filtrosPorDefecto }, cuantas };
}

/**
 * El último período que tiene el modelo, en AAAA-MM.
 *
 * Un informe de Real vs BO mira un mes cerrado, no la serie entera; pero el
 * panel ya no pide un mes —ofrece «todo» o meses puntuales— así que cuando el
 * informe necesita uno y nadie lo eligió, se toma el último que haya. Sale del
 * máximo que ya trajo el inventario: no cuesta una consulta más.
 */
async function ultimoPeriodo(ws, ds) {
  const col = MODELO.leer().columnas.periodo;
  if (!col) return null;
  let tablas;
  try { tablas = await SEMANTICA.inventario(ws, ds); } catch (e) { return null; }
  for (const t of Object.values(tablas || {})) {
    for (const c of t.columnas || []) {
      if (c.ref === col) return aMes(c.max);
    }
  }
  return null;
}

/** «2026-09», 202609 y «2026-09-01T00:00:00» son el mismo mes. */
function aMes(v) {
  const s = String(v == null ? "" : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})/) || s.match(/^(\d{4})(0[1-9]|1[0-2])$/);
  if (!m) return null;
  const mes = Number(m[2]);
  return mes >= 1 && mes <= 12 ? m[1] + "-" + String(mes).padStart(2, "0") : null;
}

/**
 * Qué medidas buscar primero. Con el tablero ya conocido, las del informe que
 * corresponde. Con uno nuevo no se sabe cuál va a ser, así que se recorren los
 * informes por turnos: así ninguno se queda sin presupuesto por culpa de otro.
 */
function medidasParaDetectar(otroTablero) {
  if (!otroTablero) return medidasDelInformeActivo();
  const listas = Object.values(INFORMES).map((i) =>
    [...new Set([...((i.requiere || {}).medidas || []), ...((i.usa || {}).medidas || [])])]);
  const salida = [];
  for (let i = 0; listas.some((l) => l[i] !== undefined); i++) {
    for (const l of listas) if (l[i] && !salida.includes(l[i])) salida.push(l[i]);
  }
  return salida;
}

app.get("/api/tablero/:ws/:ds/contexto", atajo(async (req) => {
  const { ws, ds } = req.params;
  if (!GUID.test(ws) || !GUID.test(ds)) {
    const e = new Error("Workspace y modelo deben ser GUID"); e.status = 400; throw e;
  }
  // Se prueba contra las medidas del informe que este modelo va a dar: un
  // segmentador que no sepa repartirlas no sirve para este tablero, aunque
  // técnicamente exista.
  const informe = INFORMES[req.query.informe] || INFORMES[informeQueCorresponde()] || {};
  const medidas = (informe.requiere || {}).medidas || [];
  const ctx = await CONTEXTO.contexto(ws, ds, medidas);
  return { ...ctx,
    informe: req.query.informe || informeQueCorresponde(),
    // un informe de período mira un mes cerrado; uno de cartera, la foto entera
    pidePeriodo: ((informe.requiere || {}).columnas || []).includes("periodo") };
}));

/**
 * Las medidas que el informe activo va a usar. La detección tiene un
 * presupuesto de consultas acotado: sin este orden se gastaba buscando
 * medidas de otros informes y las de éste quedaban sin encontrar.
 */
function medidasDelInformeActivo() {
  const i = INFORMES[informeQueCorresponde()] || {};
  return [...new Set([...((i.usa || {}).medidas || []), ...((i.requiere || {}).medidas || [])])];
}

/** El informe que el mapeo actual soporta. Es lo que el tablero va a mostrar. */
function informeQueCorresponde() {
  const posible = Object.keys(INFORMES).find((k) => loQueFalta(INFORMES[k]).length === 0);
  return posible || Object.keys(INFORMES)[0];
}

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
  // sin tipo explícito, el que este tablero soporta: el tablero decide el informe
  const informe = INFORMES[cuerpo.reportType || informeQueCorresponde()];
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

  // Lo que el tablero mira por defecto —una sociedad, un canal— sale del
  // mapeo, no del navegador: si el artefacto no manda nada, el informe igual
  // tiene que salir recortado como corresponde.
  const filtros = { ...guardado.filtrosPorDefecto, ...(cuerpo.filtros || {}) };
  for (const [k, v] of Object.entries(filtros)) {
    if (!v || v === "Todas") delete filtros[k];
  }
  // Los meses elegidos. Vacío = la cartera entera, a la fecha, que es como
  // se mira una foto de deuda; elegir meses es una decisión explícita.
  const meses = (Array.isArray(cuerpo.meses) ? cuerpo.meses : [])
    .filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m)))
    .slice(0, 24)
    .sort();

  /* Los informes de período —Real vs BO, Finanzas— necesitan un mes. Si el
     panel no mandó ninguno, se usa el último que tenga el modelo en vez de
     fallar con «El período debe tener formato AAAA-MM». */
  let periodo = cuerpo.periodo;
  const pidePeriodo = ((informe.requiere || {}).columnas || []).includes("periodo");
  if (!periodo && !meses.length && pidePeriodo) {
    try { periodo = await ultimoPeriodo(workspaceId, datasetId); }
    catch (e) { /* sin período: el informe mira el modelo entero */ }
  }

  const p = {
    workspaceId, datasetId,
    periodo, meses,
    filtros,
    // «a vencer» entra salvo que digan que no
    incluirAVencer: cuerpo.incluirAVencer !== false
  };

  try {
    // Las exclusiones se resuelven contra los valores que el modelo tiene de
    // verdad: una regla que no coincide con nada no es un error en DAX, es un
    // informe vacío sin explicación.
    let avisos = [];
    try {
      const r = await EXCLUSIONES.resolver(workspaceId, datasetId, guardado.exclusiones);
      p.exclusiones = r.reglas;
      avisos = r.avisos;
    } catch (e) { console.warn("[informe] exclusiones sin resolver: " + e.message); }

    // Un informe puede devolver sólo las hojas, o {secciones, tablero} cuando
    // además tiene vista interactiva. Deuda es hoy el único con las dos.
    const salida = await informe.construir(p);
    const secciones = Array.isArray(salida) ? salida : (salida.secciones || []);
    const tablero = Array.isArray(salida) ? null : (salida.tablero || null);
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
        informe: cuerpo.reportType || informeQueCorresponde(),
        titulo: informe.meta.titulo,
        bajada: informe.meta.bajada,
        fuente: informe.meta.fuente,
        periodo: p.periodo,
        meses: p.meses,
        filtros,
        incluirAVencer: p.incluirAVencer,
        avisos,
        unidad: "millones de $",
        escala: 1e6,
        workspaceId, datasetId,
        actualizado: new Date().toISOString()
      },
      secciones,
      tablero
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
            "GET /api/tablero/:ws/:ds/contexto",
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

/**
 * En Codespaces el servidor corre en la nube, así que «localhost:3000» no es
 * la dirección que hay que abrir: es la del puerto reenviado. Decir localhost
 * ahí es la diferencia entre que algo funcione y que parezca que no abre.
 */
function donde() {
  const { CODESPACE_NAME: cs, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: dom } = process.env;
  if (cs && dom) return { url: `https://${cs}-${PORT}.${dom}`, codespaces: true };
  return { url: "http://localhost:" + PORT, codespaces: false };
}

app.listen(PORT, () => {
  const d = donde();
  console.log("Backend de informes escuchando en el puerto " + PORT);
  console.log("Artefacto:  " + d.url + "/");
  if (d.codespaces) {
    console.log("            ↑ ésa es la dirección, no localhost: en Codespaces el");
    console.log("              servidor corre en la nube. Si no se abre solo, andá a");
    console.log("              la pestaña PUERTOS y abrí el 3000 con el globo.");
  }
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
  const reg = ENTORNO.deDondeSalen();
  if (reg) {
    console.log("App Entra:  " + reg.join(" y ") + " de backend/entra.json (versionado)");
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
