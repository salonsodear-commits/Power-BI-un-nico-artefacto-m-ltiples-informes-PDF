"use strict";
/**
 * Token de Microsoft Entra por client credentials (Service Principal).
 * El secreto vive acá y sólo acá: nunca sale hacia el frontend.
 * (Manual, pasos 7 a 10.)
 */
const AUTORIDAD = "https://login.microsoftonline.com";
const ALCANCE = "https://analysis.windows.net/powerbi/api/.default";

let cache = { token: null, vence: 0 };

async function obtenerToken() {
  const ahora = Date.now();
  if (cache.token && ahora < cache.vence) return cache.token;

  const { TENANT_ID, CLIENT_ID, CLIENT_SECRET } = process.env;
  for (const [k, v] of Object.entries({ TENANT_ID, CLIENT_ID, CLIENT_SECRET })) {
    if (!v) throw new Error("Falta la variable de entorno " + k);
  }

  const cuerpo = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: ALCANCE
  });

  const r = await fetch(`${AUTORIDAD}/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: cuerpo
  });

  if (!r.ok) {
    // el cuerpo de error de Entra puede incluir datos del tenant: no se registra entero
    throw new Error("No se pudo obtener el token (HTTP " + r.status + ")");
  }
  const j = await r.json();
  cache = {
    token: j.access_token,
    // 60 s de margen para no usar un token que vence en vuelo
    vence: ahora + (Number(j.expires_in || 3600) - 60) * 1000
  };
  return cache.token;
}

module.exports = { obtenerToken };
