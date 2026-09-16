"use strict";
/**
 * Primera prueba: autenticación + workspace + dataset + una consulta mínima.
 * Antes de construir los informes, que esto pase. (Manual, paso 11.)
 *
 *   npm run prueba                       usa backend/modelo.json o .env
 *   npm run prueba -- <ws> <ds>          probá otro tablero sin tocar nada
 *   npm run prueba -- <ws> <ds> "EVALUATE ROW(\"R\", [Real])"
 */
require("./entorno");
const { consultar } = require("./powerbi/client");
const MODELO = require("./modelo");

const [, , argWs, argDs, argDax] = process.argv;
const guardado = (() => { try { return MODELO.leer(); } catch (e) { return {}; } })();

const ws = argWs || guardado.workspaceId || process.env.POWERBI_WORKSPACE_ID;
const ds = argDs || guardado.datasetId || process.env.POWERBI_DATASET_ID;
const dax = argDax || 'EVALUATE ROW("Prueba", 1)';

(async () => {
  console.log("Workspace: " + (ws || "(sin definir)"));
  console.log("Dataset:   " + (ds || "(sin definir)"));
  console.log("Consulta:  " + dax.replace(/\s+/g, " ").slice(0, 90) + "\n");

  const faltan = ["TENANT_ID", "CLIENT_ID", "CLIENT_SECRET"].filter((k) => !process.env[k]);
  if (faltan.length) {
    console.error("Faltan " + faltan.join(", ") + " en backend/.env");
    console.error("  cp backend/.env.example backend/.env   y completalo");
    process.exitCode = 1;
    return;
  }

  try {
    const filas = await consultar(ws, ds, dax);
    console.log("OK · Execute Queries respondió " + filas.length + " fila(s):");
    console.log(JSON.stringify(filas.slice(0, 5), null, 2));
    console.log("\nSiguiente paso: levantá el backend (npm run dev) y abrí");
    console.log("Conectar a Power BI → Consola DAX para descubrir tus medidas.");
  } catch (e) {
    console.error("FALLÓ: " + e.message + "\n");
    console.error("Revisá, en este orden:");
    console.error("  1. Execute Queries habilitado en el tenant.");
    console.error("  2. El Service Principal autorizado (tenant setting) y agregado");
    console.error("     al workspace con Read + Build sobre el modelo.");
    console.error("  3. Si el modelo usa RLS o SSO: el Service Principal no sirve ahí.");
    process.exitCode = 1;
  }
})();
