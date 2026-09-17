/**
 * Qué filtros trae puesto el tablero.
 *
 * Power Query puede dejar el modelo ya recortado —una sola sociedad, un solo
 * canal— y eso no se ve por la API: no hay forma de leer los pasos de Power
 * Query desde executeQueries. Pero sí se puede mirar el dato: si una dimensión
 * tiene UN solo valor distinto, el recorte ya está hecho y el informe no debe
 * volver a ofrecerla como filtro, sino mostrarla como contexto.
 *
 * Es la diferencia entre un panel que pide «Sociedad» al pedo y uno que dice
 * «Sociedad: IHSA S.A.» porque es lo único que hay.
 */
const { consultar } = require("./client");
const MODELO = require("../modelo");
const Q = require("./queries");

// Las que tiene sentido mostrar como contexto o pedir como filtro.
const DIMENSIONES = [
  { clave: "sociedad", rotulo: "Sociedad" },
  { clave: "canal",    rotulo: "Canal" },
  { clave: "vertical", rotulo: "Negocio" },
  { clave: "moneda",   rotulo: "Moneda" }
];

const TOPE = 12;   // con 12 alcanza para decidir; más sería traer la dimensión entera

async function contexto(workspaceId, datasetId) {
  const m = MODELO.leer();
  const salida = [];

  await Promise.all(DIMENSIONES.map(async (d) => {
    const col = m.columnas[d.clave];
    if (!col || (m.rotos || []).includes("columnas." + d.clave)) return;
    try {
      const filas = await consultar(workspaceId, datasetId, Q.valoresDe(col, TOPE));
      const vistos = filas
        .map((f) => Object.values(f)[0])
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
        .map(String);
      const valores = [...new Set(vistos)];
      if (!valores.length) return;
      salida.push({
        clave: d.clave, rotulo: d.rotulo, ref: col,
        valores: valores.slice(0, TOPE).sort((a, b) => a.localeCompare(b, "es")),
        // un solo valor = el tablero ya viene filtrado por esa dimensión
        fijo: valores.length === 1,
        truncado: filas.length >= TOPE
      });
    } catch (e) {
      // una dimensión que no responde no rompe el contexto: simplemente no está
      console.warn("[contexto] " + d.clave + ": " + e.message);
    }
  }));

  const orden = DIMENSIONES.map((d) => d.clave);
  salida.sort((a, b) => orden.indexOf(a.clave) - orden.indexOf(b.clave));
  return {
    dimensiones: salida,
    // atajos, que es lo que el artefacto termina usando
    fijos: salida.filter((x) => x.fijo).map((x) => ({ rotulo: x.rotulo, valor: x.valores[0] })),
    elegibles: salida.filter((x) => !x.fijo)
  };
}

module.exports = { contexto, DIMENSIONES };
