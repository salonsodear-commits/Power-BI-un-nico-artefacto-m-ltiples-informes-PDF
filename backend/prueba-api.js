"use strict";
/**
 * Primera prueba: autenticación + workspace + dataset + una consulta mínima.
 * Antes de construir los informes, que esto pase. (Manual, paso 11.)
 *
 *   node prueba-api.js
 */
require("dotenv").config();
const { consultar } = require("./powerbi/client");

(async () => {
  const ws = process.env.POWERBI_WORKSPACE_ID;
  const ds = process.env.POWERBI_DATASET_ID;
  console.log("Workspace:", ws, "\nDataset:  ", ds, "\n");
  try {
    const filas = await consultar(ws, ds, 'EVALUATE ROW("Prueba", 1)');
    console.log("OK · Execute Queries responde:", JSON.stringify(filas));
    console.log("\nProbá ahora una medida real, por ejemplo:");
    console.log('  EVALUATE ROW("Real", [Real])');
  } catch (e) {
    console.error("FALLÓ:", e.message);
    console.error("\nRevisá: Execute Queries habilitado · Read + Build sobre el modelo ·");
    console.error("Service Principal autorizado en el workspace · RLS/SSO en el dataset.");
    process.exitCode = 1;
  }
})();
