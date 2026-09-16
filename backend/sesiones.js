"use strict";
/**
 * Una sesión por persona, no una por servidor.
 *
 * Si dos compañeros usan el mismo backend, cada uno tiene que entrar con su
 * cuenta y consultar Power BI con SUS permisos. Guardar un único token haría
 * que el segundo viera los datos del primero, salteando el RLS del modelo.
 *
 * Cada navegador recibe una cookie con un identificador al azar; el token va
 * guardado contra ese identificador. El contexto viaja por AsyncLocalStorage
 * para no tener que pasar el pedido a mano por todas las capas.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const almacen = new AsyncLocalStorage();
const ARCHIVO = path.join(__dirname, ".sesiones.json");
const COOKIE = "informes_sid";
const VIDA_DIAS = 30;

/** sid → { access_token, refresh_token, vence, usuario, visto } */
let sesiones = cargar();

function cargar() {
  try { return JSON.parse(fs.readFileSync(ARCHIVO, "utf8")); }
  catch (e) { return {}; }
}

function persistir() {
  // Guarda refresh tokens: permisos de sólo dueño, y nunca al repositorio.
  const tmp = ARCHIVO + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sesiones), { mode: 0o600 });
  fs.renameSync(tmp, ARCHIVO);
}

/** Descarta lo que lleve más de VIDA_DIAS sin usarse. */
function limpiar() {
  const corte = Date.now() - VIDA_DIAS * 864e5;
  let cambio = false;
  for (const [sid, s] of Object.entries(sesiones)) {
    if ((s.visto || 0) < corte) { delete sesiones[sid]; cambio = true; }
  }
  if (cambio) persistir();
}

const leerCookie = (req) => {
  const crudo = req.headers.cookie;
  if (!crudo) return null;
  for (const parte of crudo.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === COOKIE) {
      const v = parte.slice(i + 1).trim();
      return /^[A-Za-z0-9_-]{22,64}$/.test(v) ? v : null;
    }
  }
  return null;
};

/**
 * Middleware: asegura la cookie y corre el pedido dentro de su contexto.
 * `secure` sólo cuando la conexión ya es https, para no romper localhost.
 */
function middleware(req, res, next) {
  let sid = leerCookie(req);
  if (!sid) {
    sid = crypto.randomBytes(24).toString("base64url");
    const https = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `${COOKIE}=${sid}; Path=/; Max-Age=${VIDA_DIAS * 86400}; HttpOnly; SameSite=Lax` +
      (https ? "; Secure" : ""));
  }
  almacen.run({ sid }, next);
}

/** El identificador del pedido en curso. */
function sid() {
  const ctx = almacen.getStore();
  if (!ctx || !ctx.sid) {
    // Fuera de un pedido HTTP (prueba-api.js, por ejemplo): una sola sesión local.
    return "local";
  }
  return ctx.sid;
}

const obtener = () => sesiones[sid()] || null;

function guardar(s) {
  sesiones[sid()] = Object.assign({}, s, { visto: Date.now() });
  persistir();
  return sesiones[sid()];
}

/** Escribe contra un sid explícito: lo usa el sondeo, que corre fuera del pedido. */
function guardarEn(id, s) {
  sesiones[id] = Object.assign({}, s, { visto: Date.now() });
  persistir();
  return sesiones[id];
}

function borrar() {
  delete sesiones[sid()];
  persistir();
}

/** Cuántas personas tienen sesión abierta. Sólo para mostrar en el arranque. */
const cuantas = () => Object.keys(sesiones).length;

limpiar();

module.exports = { middleware, sid, obtener, guardar, guardarEn, borrar, cuantas, ARCHIVO };
