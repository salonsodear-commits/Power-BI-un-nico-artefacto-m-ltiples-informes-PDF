"use strict";
/**
 * Carga de backend/.env y diagnóstico de por qué no aparece lo que uno cree
 * haber puesto. Los tres tropiezos habituales son siempre los mismos: el valor
 * quedó en .env.example, la línea siguió comentada, o el archivo no existe.
 *
 * Nunca se imprime un valor: sólo el nombre de la variable y su estado.
 */
const fs = require("fs");
const path = require("path");

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const ARCHIVO = path.join(__dirname, ".env");
const EJEMPLO = path.join(__dirname, ".env.example");
const REGISTRO = path.join(__dirname, "entra.json");

// Ruta absoluta: así no importa desde dónde se arranque el proceso.
require("dotenv").config({ path: ARCHIVO });

/**
 * El registro de app versionado, como último recurso.
 *
 * clientId y tenantId son identificadores públicos —viajan en la URL de
 * cualquier login de Microsoft— así que pueden vivir en el repositorio y que
 * nadie del equipo tenga que configurar nada. El secreto, que sí lo es, no
 * entra nunca: el modo delegado no usa ninguno.
 *
 * El orden es el mismo que usa dotenv: lo que ya está en el entorno gana, así
 * que un .env, un secreto de Codespaces o una variable exportada a mano siguen
 * pisando esto sin tocar el archivo.
 */
let origenRegistro = null;
(function registroVersionado() {
  let j;
  try { j = JSON.parse(fs.readFileSync(REGISTRO, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") console.warn("[entorno] entra.json ignorado:", e.message);
    return;
  }
  const puestas = [];
  for (const [clave, valor] of [["CLIENT_ID", j.clientId], ["TENANT_ID", j.tenantId]]) {
    if (process.env[clave] || !valor) continue;
    if (!GUID.test(String(valor))) {
      console.warn("[entorno] " + clave + " de entra.json no es un GUID; se ignora");
      continue;
    }
    process.env[clave] = String(valor);
    puestas.push(clave);
  }
  if (puestas.length) origenRegistro = puestas;
})();



/** Lee un .env y devuelve qué claves trae y cuáles quedaron comentadas. */
function inspeccionar(ruta) {
  let texto;
  try { texto = fs.readFileSync(ruta, "utf8"); }
  catch (e) { return null; }

  const activas = [], comentadas = [];
  for (const cruda of texto.split(/\r?\n/)) {
    const linea = cruda.trim();
    if (!linea) continue;
    const comentada = linea.startsWith("#");
    const cuerpo = comentada ? linea.replace(/^#+\s*/, "") : linea;
    const m = cuerpo.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, clave, valor] = m;
    // un valor de plantilla sin completar no cuenta como puesto
    const plantilla = /^(0{8}-|pegar-aca|el-id-|<|\.\.\.)/.test(valor.trim()) || valor.trim() === "";
    (comentada ? comentadas : activas).push({ clave, plantilla });
  }
  return { activas, comentadas };
}

/**
 * Explica por qué falta cada variable, mirando el archivo real.
 * Devuelve las líneas a imprimir, ya ordenadas de más probable a menos.
 */
function diagnostico(faltan) {
  if (!faltan.length) return [];
  const yo = inspeccionar(ARCHIVO);
  const lineas = [];

  if (!yo) {
    lineas.push("No existe backend/.env. Rehacelo con:");
    lineas.push("");
    lineas.push("    npm run configurar");
    lineas.push("");
    lineas.push("Pregunta los dos IDs y te dice de qué pantalla de Entra sacarlos.");
    // sólo interesa si completó, ahí, alguna de las que faltan
    const ej = inspeccionar(EJEMPLO);
    const puestas = ej
      ? ej.activas.filter((v) => !v.plantilla && faltan.includes(v.clave)).map((v) => v.clave)
      : [];
    if (puestas.length) {
      lineas.push("");
      lineas.push("Ojo: parece que completaste " + puestas.join(" y ") + " dentro de");
      lineas.push(".env.example. Ese archivo es sólo la plantilla y no se lee.");
      lineas.push("Copialo a .env y el valor viaja con él.");
    }
    lineas.push(...ENV_SE_PIERDE);
    return lineas;
  }

  for (const clave of faltan) {
    const com = yo.comentadas.find((v) => v.clave === clave);
    const act = yo.activas.find((v) => v.clave === clave);
    if (com) {
      lineas.push(clave + ": la línea está en backend/.env pero COMENTADA.");
      lineas.push("    Borrale el # del principio y guardá.");
    } else if (act && act.plantilla) {
      lineas.push(clave + ": está en backend/.env pero con el valor de ejemplo sin reemplazar.");
    } else {
      lineas.push(clave + ": no aparece en backend/.env. Agregá una línea " + clave + "=...");
    }
  }

  const leidas = yo.activas.filter((v) => !v.plantilla).length;
  lineas.push("");
  lineas.push("backend/.env existe y tiene " + leidas + " variable(s) con valor" +
    (yo.comentadas.length ? " y " + yo.comentadas.length + " comentada(s)" : "") + ".");
  lineas.push("Después de editarlo hay que reiniciar: Ctrl+C y npm run dev otra vez.");
  lineas.push("O dejá que lo escriba solo:  npm run configurar");
  return lineas;
}

/**
 * .env está fuera del repositorio a propósito, así que no hay nada que
 * restaurar desde git cuando el contenedor se recrea. Decirlo acá evita la
 * segunda vez.
 */
const ENV_SE_PIERDE = [
  "",
  "backend/.env vive sólo en este disco: está fuera del repositorio a",
  "propósito, así que si el Codespace se recrea, se va con él. Para que",
  "vuelva solo, guardá los dos IDs como secretos del repositorio:",
  "  GitHub → tu repo → Settings → Secrets and variables → Codespaces",
  "El backend los lee del entorno aunque backend/.env no exista."
];

/** De dónde salieron CLIENT_ID y TENANT_ID, para el mensaje de arranque. */
const deDondeSalen = () => origenRegistro;

module.exports = { ARCHIVO, REGISTRO, diagnostico, inspeccionar, deDondeSalen };
