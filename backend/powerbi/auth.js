"use strict";
/**
 * Dos formas de autenticarse contra Power BI.
 *
 *   delegado  (por defecto) — entrás vos con tu cuenta corporativa, por el
 *             flujo de código de dispositivo. La API te ve con TUS permisos:
 *             los mismos que ya tenés al abrir el tablero en el navegador.
 *             No requiere el tenant setting de Service Principals, ni que
 *             nadie te agregue al workspace, y respeta RLS correctamente.
 *             Sólo necesita un CLIENT_ID de una app registrada como
 *             cliente público. No lleva secreto.
 *
 *   servicio  — Service Principal (client credentials). Corre sin que haya
 *             nadie sentado adelante, pero exige que un administrador
 *             habilite el tenant setting y agregue la app al workspace, y
 *             no funciona con modelos que usan RLS o SSO.
 *
 * El modo se elige solo: si hay CLIENT_SECRET es «servicio», si no «delegado».
 * AUTH_MODO lo fuerza.
 */
const fs = require("fs");
const path = require("path");

const AUTORIDAD = "https://login.microsoftonline.com";
const RECURSO = "https://analysis.windows.net/powerbi/api";
const ALCANCE_SERVICIO = RECURSO + "/.default";
const ALCANCE_DELEGADO = [
  RECURSO + "/Dataset.Read.All",
  RECURSO + "/Workspace.Read.All",
  RECURSO + "/Report.Read.All",
  "openid", "profile", "offline_access"
].join(" ");

const ARCHIVO_SESION = path.join(__dirname, "..", ".sesion.json");

const modo = () =>
  process.env.AUTH_MODO || (process.env.CLIENT_SECRET ? "servicio" : "delegado");
const inquilino = () => process.env.TENANT_ID || "organizations";

/* ═══ modo servicio ═══════════════════════════════════════════════════ */
let cacheServicio = { token: null, vence: 0 };

async function tokenServicio() {
  if (cacheServicio.token && Date.now() < cacheServicio.vence) return cacheServicio.token;

  const { TENANT_ID, CLIENT_ID, CLIENT_SECRET } = process.env;
  for (const [k, v] of Object.entries({ TENANT_ID, CLIENT_ID, CLIENT_SECRET })) {
    if (!v) throw new Error("Falta la variable de entorno " + k);
  }
  const j = await postToken(TENANT_ID, {
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: ALCANCE_SERVICIO
  });
  cacheServicio = { token: j.access_token, vence: Date.now() + (j.expires_in - 60) * 1000 };
  return cacheServicio.token;
}

/* ═══ modo delegado: código de dispositivo ════════════════════════════ */
let sesion = null;          // { access_token, refresh_token, vence, usuario }
let enCurso = null;         // { user_code, verification_uri, vence, estado, error }

function cargarSesion() {
  if (sesion) return sesion;
  try { sesion = JSON.parse(fs.readFileSync(ARCHIVO_SESION, "utf8")); }
  catch (e) { sesion = null; }
  return sesion;
}
function guardarSesion(s) {
  sesion = s;
  // el refresh token es tan sensible como un secreto: permisos de sólo dueño
  fs.writeFileSync(ARCHIVO_SESION, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function borrarSesion() {
  sesion = null; enCurso = null;
  try { fs.unlinkSync(ARCHIVO_SESION); } catch (e) { /* ya no estaba */ }
}

/** Arranca el flujo: devuelve el código que el usuario tipea en Microsoft. */
async function iniciarIngreso() {
  const CLIENT_ID = process.env.CLIENT_ID;
  if (!CLIENT_ID) throw new Error("Falta CLIENT_ID en backend/.env");

  const r = await fetch(`${AUTORIDAD}/${inquilino()}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: ALCANCE_DELEGADO })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || "No se pudo iniciar el ingreso");

  enCurso = {
    user_code: j.user_code,
    verification_uri: j.verification_uri,
    vence: Date.now() + (j.expires_in || 900) * 1000,
    estado: "esperando"
  };
  sondear(CLIENT_ID, j.device_code, (j.interval || 5) * 1000);
  return { userCode: j.user_code, url: j.verification_uri, expiraEn: j.expires_in || 900 };
}

/** Pregunta a Microsoft cada pocos segundos si el usuario ya entró. */
function sondear(clientId, deviceCode, intervalo) {
  const paso = async () => {
    if (!enCurso || enCurso.estado !== "esperando") return;
    if (Date.now() > enCurso.vence) {
      enCurso.estado = "error";
      enCurso.error = "El código venció. Probá de nuevo.";
      return;
    }
    try {
      const j = await postToken(inquilino(), {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: deviceCode
      });
      guardarSesion({
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        vence: Date.now() + (j.expires_in - 60) * 1000,
        usuario: usuarioDelToken(j.access_token) || usuarioDelToken(j.id_token)
      });
      enCurso.estado = "listo";
    } catch (e) {
      if (e.codigo === "authorization_pending") return setTimeout(paso, intervalo);
      if (e.codigo === "slow_down") return setTimeout(paso, intervalo + 5000);
      enCurso.estado = "error";
      enCurso.error = e.message;
    }
  };
  setTimeout(paso, intervalo);
}

async function tokenDelegado() {
  const s = cargarSesion();
  if (!s) {
    const e = new Error("No hay sesión iniciada. Entrá con tu cuenta desde Conectar → Sesión.");
    e.status = 401; e.necesitaIngreso = true;
    throw e;
  }
  if (Date.now() < s.vence) return s.access_token;

  try {
    const j = await postToken(inquilino(), {
      grant_type: "refresh_token",
      client_id: process.env.CLIENT_ID,
      refresh_token: s.refresh_token,
      scope: ALCANCE_DELEGADO
    });
    guardarSesion({
      access_token: j.access_token,
      refresh_token: j.refresh_token || s.refresh_token,
      vence: Date.now() + (j.expires_in - 60) * 1000,
      usuario: s.usuario
    });
    return sesion.access_token;
  } catch (e) {
    borrarSesion();
    const err = new Error("La sesión venció. Volvé a entrar con tu cuenta.");
    err.status = 401; err.necesitaIngreso = true;
    throw err;
  }
}

/* ═══ común ═══════════════════════════════════════════════════════════ */
async function postToken(tenant, cuerpo) {
  const r = await fetch(`${AUTORIDAD}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(cuerpo)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // el cuerpo de Entra puede traer datos del tenant: sólo se propaga lo útil
    const e = new Error(j.error_description
      ? String(j.error_description).split("\n")[0]
      : "Microsoft respondió " + r.status);
    e.codigo = j.error;
    throw e;
  }
  return j;
}

/** El UPN que viene dentro del token, sólo para mostrarlo en pantalla. */
function usuarioDelToken(jwt) {
  try {
    const carga = JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString());
    return carga.upn || carga.preferred_username || carga.unique_name || null;
  } catch (e) { return null; }
}

/** El token que corresponda al modo activo. */
async function obtenerToken() {
  return modo() === "servicio" ? tokenServicio() : tokenDelegado();
}

function estado() {
  const m = modo();
  if (m === "servicio") {
    const faltan = ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET"].filter((k) => !process.env[k]);
    return { modo: m, conectado: faltan.length === 0, faltan };
  }
  const s = cargarSesion();
  return {
    modo: m,
    conectado: !!s,
    usuario: s ? s.usuario : null,
    faltan: process.env.CLIENT_ID ? [] : ["CLIENT_ID"],
    ingreso: enCurso && enCurso.estado === "esperando"
      ? { userCode: enCurso.user_code, url: enCurso.verification_uri }
      : null,
    error: enCurso && enCurso.estado === "error" ? enCurso.error : null
  };
}

module.exports = { obtenerToken, iniciarIngreso, borrarSesion, estado, modo };
