"use strict";
/**
 * Rehace backend/.env sin abrir un editor.
 *
 *   npm run configurar                       pregunta los dos IDs
 *   npm run configurar -- <CLIENT> <TENANT>  sin preguntar
 *
 * Existe porque .env está fuera del repositorio a propósito (manual, paso 20):
 * vive sólo en el disco de tu máquina o de tu Codespace, así que si el
 * contenedor se recrea, el archivo se va con él y no hay nada que restaurar
 * desde git. Rehacerlo tiene que costar un comando, no una búsqueda.
 *
 * CLIENT_ID y TENANT_ID no son secretos: son identificadores públicos, van en
 * la URL de cualquier login de Microsoft. El secreto —si algún día usás modo
 * Service Principal— es CLIENT_SECRET, y este script se niega a tocarlo.
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const ARCHIVO = path.join(__dirname, ".env");
const EJEMPLO = path.join(__dirname, ".env.example");
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAMPOS = [
  { clave: "CLIENT_ID", rotulo: "Id. de aplicación (cliente)" },
  { clave: "TENANT_ID", rotulo: "Id. de directorio (inquilino)" }
];

const DONDE = [
  "Los dos están en la MISMA pantalla de Entra, uno debajo del otro:",
  "",
  "  1. https://entra.microsoft.com  (entrá con tu cuenta corporativa)",
  "  2. Aplicaciones → Registros de aplicaciones → Todas las aplicaciones",
  "  3. Abrí tu app → Información general",
  "",
  "     Id. de aplicación (cliente)  → CLIENT_ID",
  "     Id. de directorio (inquilino) → TENANT_ID"
];

/**
 * Pone o reemplaza una clave, conservando todo lo demás del archivo.
 *
 * El orden importa. Primero las líneas activas —todas, no la primera: dos
 * CLIENT_ID en el mismo archivo es justo el enredo que esto viene a evitar—.
 * Si no hay ninguna, se despierta una comentada, que es como quedó la última
 * vez que esto falló. Los comentarios en prosa («#   CLIENT_ID = «Id. de
 * aplicación»») no se tocan nunca: explican, no configuran.
 */
function fijar(texto, clave, valor) {
  const linea = clave + "=" + valor;
  const activa = new RegExp("^[ \\t]*" + clave + "[ \\t]*=.*$", "gm");
  if (activa.test(texto)) {
    let primera = true;
    return texto.replace(new RegExp(activa.source, "gm"),
      () => (primera ? (primera = false, linea) : "\u0000"))
      .split("\n").filter((l) => l !== "\u0000").join("\n");
  }
  // `# CLAVE=valor`, sin espacio antes del =: la convención de .env.example
  // para una opción apagada. `#   CLAVE = texto» es prosa y no entra acá.
  const apagada = new RegExp("^[ \\t]*#[ \\t]*" + clave + "=.*$", "m");
  if (apagada.test(texto)) return texto.replace(apagada, linea);
  return texto.trimEnd() + "\n" + linea + "\n";
}

function escribir(valores) {
  // Si ya hay un .env se respeta: PORT u ORIGENES_PERMITIDOS pueden estar tocados.
  let texto;
  let base;
  try { texto = fs.readFileSync(ARCHIVO, "utf8"); base = ".env que ya estaba"; }
  catch (e) {
    texto = fs.readFileSync(EJEMPLO, "utf8");
    base = ".env.example";
    texto = texto.replace(/^# Copiar a \.env.*$/m,
      "# Generado por `npm run configurar`. NUNCA va al repositorio.");
  }
  for (const [clave, valor] of Object.entries(valores)) texto = fijar(texto, clave, valor);
  // 0600: sólo tu usuario. Hoy no hay secreto adentro, pero el archivo es el
  // lugar donde mañana podría haberlo.
  fs.writeFileSync(ARCHIVO, texto, { mode: 0o600 });
  try { fs.chmodSync(ARCHIVO, 0o600); } catch (e) { /* en Windows no aplica */ }
  return base;
}

function cerrar(valores) {
  const base = escribir(valores);
  console.log("\n✓ backend/.env escrito (a partir de " + base + ")");
  for (const c of CAMPOS) console.log("   " + c.clave.padEnd(10) + valores[c.clave]);
  console.log("\nArrancá con:  npm run dev");
  console.log("\n── Para que no se pierda de nuevo ──");
  console.log("Si trabajás en Codespaces, el .env muere con el contenedor. Guardá");
  console.log("los dos IDs como secretos del repositorio y vuelven solos siempre:");
  console.log("  GitHub → tu repo → Settings → Secrets and variables → Codespaces");
  console.log("  → New repository secret, uno por cada uno (CLIENT_ID, TENANT_ID).");
  console.log("El backend los toma del entorno aunque no exista backend/.env.");
}

const args = process.argv.slice(2).filter((a) => a !== "--");

if (args.some((a) => /^-?-?(h|help|ayuda)$/i.test(a))) {
  console.log("Uso:  npm run configurar  [CLIENT_ID TENANT_ID]\n");
  DONDE.forEach((l) => console.log(l));
  process.exit(0);
}

if (args.length) {
  if (args.length !== 2) {
    console.error("Se esperan exactamente dos valores: CLIENT_ID y TENANT_ID.");
    console.error("Uso:  npm run configurar -- <CLIENT_ID> <TENANT_ID>");
    process.exit(1);
  }
  const malos = args.filter((a) => !GUID.test(a));
  if (malos.length) {
    console.error("No parecen GUID: " + malos.join(", "));
    console.error("Se espera la forma 00000000-0000-0000-0000-000000000000.");
    process.exit(1);
  }
  cerrar({ CLIENT_ID: args[0], TENANT_ID: args[1] });
} else {
  console.log("Configurar backend/.env\n");
  DONDE.forEach((l) => console.log(l));
  console.log("\nNo pegues acá un Client Secret: no hace falta y no se guarda.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pregunta = (t) => new Promise((r) => rl.question(t, r));
  const valores = {};

  (async () => {
    for (const c of CAMPOS) {
      for (;;) {
        const v = (await pregunta(c.rotulo + "\n  " + c.clave + " = ")).trim();
        if (GUID.test(v)) { valores[c.clave] = v; break; }
        console.log(v
          ? "  ✗ Eso no tiene forma de GUID. Copialo entero desde Entra.\n"
          : "  ✗ Hace falta un valor.\n");
      }
    }
    rl.close();
    cerrar(valores);
  })().catch((e) => { rl.close(); console.error(e.message); process.exit(1); });
}
