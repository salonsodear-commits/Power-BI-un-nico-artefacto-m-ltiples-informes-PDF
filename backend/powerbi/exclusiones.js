"use strict";
/**
 * Resolver las exclusiones contra los valores que el modelo tiene de verdad.
 *
 * Una regla escrita a mano —«canal contiene 32 Corporaciones»— puede no
 * coincidir con nada, y en DAX eso NO es un error: es cero filas. El informe
 * sale vacío y nada dice por qué. Pasó exactamente eso: el tablero rotula el
 * canal «Corporaciones - Petróleo», sin el «32», y la regla lo dejaba afuera
 * todo.
 *
 * Así que antes de armar la consulta se miran los valores reales de esa
 * columna y la regla se reescribe con los que existen. Si no coincide ninguno,
 * la regla NO se aplica y queda un aviso: es preferible un informe de más que
 * uno vacío sin explicación.
 */
const { consultar } = require("./client");
const Q = require("./queries");

const VIDA = 5 * 60 * 1000;          // los valores de una dimensión no cambian a cada rato
const cache = new Map();             // "ws:ds:col" → { cuando, valores }

/** Sin tildes ni puntuación: «IHSA S.A.» y «IHSA SA» son lo mismo. */
const pelar = (x) => String(x).normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]/g, "");

async function valoresDe(ws, ds, col) {
  const clave = ws + ":" + ds + ":" + col;
  const hay = cache.get(clave);
  if (hay && Date.now() - hay.cuando < VIDA) return hay.valores;
  const filas = await consultar(ws, ds, Q.valoresDe(col, 200));
  const valores = [...new Set(filas
    .map((f) => Object.values(f)[0])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(String))];
  cache.set(clave, { cuando: Date.now(), valores });
  return valores;
}

/** Los valores reales que una regla de texto pretende nombrar. */
function calzar(regla, valores) {
  if (regla.igual != null && regla.igual !== "") {
    const q = pelar(regla.igual);
    const exacto = valores.filter((v) => v === regla.igual || pelar(v) === q);
    return exacto.length ? exacto : valores.filter((v) => pelar(v).includes(q) || q.includes(pelar(v)));
  }
  const q = pelar(regla.contiene);
  return valores.filter((v) => pelar(v).includes(q));
}

/**
 * @returns {{reglas, avisos}} las reglas listas para el DAX, y qué no cerró.
 */
async function resolver(workspaceId, datasetId, reglas) {
  const salida = [], avisos = [];

  for (const r of reglas || []) {
    // Las de lista, la de orden de pago y las de varias columnas ya nombran
    // valores exactos o son condiciones: no hay nada que resolver.
    const esTexto = (r.contiene || (r.igual != null && r.igual !== "")) && r.campo && !r.campos;
    if (!esTexto) { salida.push(r); continue; }

    const col = Q.c(r.campo);
    if (!col) { salida.push(r); continue; }

    let valores;
    try { valores = await valoresDe(workspaceId, datasetId, col); }
    catch (e) {
      // sin poder comprobar, se aplica tal cual: es lo que se pidió
      console.warn("[exclusiones] no pude leer " + col + ": " + e.message);
      salida.push(r);
      continue;
    }

    const calzan = calzar(r, valores);
    if (!calzan.length) {
      avisos.push({
        campo: r.campo, ref: col,
        buscado: r.contiene || r.igual,
        hay: valores.slice(0, 8),
        texto: `La exclusión de ${r.campo} buscaba «${r.contiene || r.igual}» y ese valor no ` +
               `existe en ${col}. Se ignoró para no vaciar el informe` +
               (valores.length ? `; los valores reales son: ${valores.slice(0, 5).join(", ")}` +
                 (valores.length > 5 ? "…" : "") : "") + "."
      });
      console.warn("[exclusiones] " + avisos[avisos.length - 1].texto);
      continue;                       // NO se aplica
    }

    // se reescribe con lo que el modelo sí tiene
    salida.push({ campo: r.campo, incluir: calzan });
    if (calzan.length > 1) {
      console.log("[exclusiones] " + r.campo + " «" + (r.contiene || r.igual) + "» → " +
                  calzan.length + " valores: " + calzan.join(", "));
    }
  }
  return { reglas: salida, avisos };
}

module.exports = { resolver, valoresDe, pelar };
