"use strict";
/**
 * Construcción de DAX a partir del mapeo del modelo.
 *
 * Nada de nombres de medidas o columnas fijos: todo sale de modelo.json, que
 * es lo que hace que el mismo generador sirva para cualquier tablero.
 *
 * Todo lo que se interpola acá viene ya validado por modelo.js (sólo formas
 * `[Medida]` y `Tabla[Columna]`) o pasa por `lit()`.
 */
const MODELO = require("../modelo");
const { tablaDe } = MODELO;

/** Referencia de medida mapeada, o null si el modelo no la tiene. */
const m = (clave) => MODELO.leer().medidas[clave] || null;
/** Referencia de columna mapeada, o null. */
const c = (clave) => MODELO.leer().columnas[clave] || null;

/** Literal de texto DAX: la comilla doble se escapa duplicándola. */
function lit(valor) {
  const s = String(valor == null ? "" : valor);
  if (s.length > 120) throw new Error("Valor de filtro demasiado largo");
  // \p{Zl}/\p{Zp} cubren los separadores de línea que no son \n
  if (/[\r\n]/.test(s) || /\p{Zl}|\p{Zp}/u.test(s)) throw new Error("Valor de filtro inválido");
  return '"' + s.replace(/"/g, '""') + '"';
}

/** "2026-07" → 202607 */
function claveMes(periodo) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || "")) {
    throw new Error("El período debe tener formato AAAA-MM");
  }
  return Number(periodo.replace("-", ""));
}

/** Los n meses que terminan en `periodo`, como claves AAAAMM. */
function ventanaMeses(periodo, n) {
  const k = claveMes(periodo);
  const a = Math.floor(k / 100), mes = k % 100;
  const claves = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(a, mes - 1 - i, 1));
    claves.push(d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1));
  }
  return claves;
}

/**
 * El valor con el que se compara la columna de período, en su propio tipo.
 * Un modelo guarda el mes como entero 202607 o como texto "2026-07"; los dos
 * son igual de comunes y el literal DAX es distinto.
 */
function valorPeriodo(clave) {
  const s = String(clave);
  return MODELO.leer().periodoFormato === "texto"
    ? lit(s.slice(0, 4) + "-" + s.slice(4))
    : s;
}

/** Filtro del mes pedido. */
function fPeriodo(periodo) {
  const col = c("periodo");
  if (!col) throw new Error("Falta mapear la columna de período del calendario");
  return `FILTER(ALL(${tablaDe(col)}), ${col} = ${valorPeriodo(claveMes(periodo))})`;
}

/**
 * Filtro de los meses elegidos, o ninguno si no se eligió.
 *
 * La cartera es una FOTO: por defecto se mira entera, a la fecha, sin corte de
 * período. Elegir uno o varios meses es una decisión explícita —«qué venció en
 * julio»— y sólo entonces aparece el filtro.
 */
function fMeses(meses) {
  const col = c("periodo");
  if (!col || !Array.isArray(meses) || !meses.length) return null;
  const vals = meses.map((m) => valorPeriodo(claveMes(m))).join(", ");
  return `FILTER(ALL(${tablaDe(col)}), ${col} IN {${vals}})`;
}

/** Filtro de la ventana de n meses que termina en `periodo`. */
function fVentana(periodo, n) {
  const col = c("periodo");
  if (!col) throw new Error("Falta mapear la columna de período del calendario");
  const vals = ventanaMeses(periodo, n).map(valorPeriodo).join(", ");
  return `FILTER(ALL(${tablaDe(col)}), ${col} IN {${vals}})`;
}

/**
 * Los filtros que pidió el usuario, uno por dimensión mapeada.
 *
 * No hay lista fija de dimensiones: llegan por clave desde el panel, que a su
 * vez sólo ofrece las que el contexto probó que funcionan. Acepta también las
 * claves sueltas de la forma vieja (`{sociedad, vertical}`) para no romper a
 * los informes que todavía las usan así.
 */
function fDimensiones(p) {
  const pedidos = p && p.filtros ? p.filtros
    : { sociedad: (p || {}).sociedad, vertical: (p || {}).vertical };
  const partes = [];
  for (const [clave, valor] of Object.entries(pedidos || {})) {
    const col = c(clave);
    if (!col || !valor || valor === "Todas") continue;
    partes.push(`FILTER(ALL(${tablaDe(col)}), ${col} = ${lit(valor)})`);
  }
  return partes;
}

/** Todos los filtros, ya listos para pegar como argumentos. */
function argsFiltro(p, { ventana } = {}) {
  const partes = [ventana ? fVentana(p.periodo, ventana) : fPeriodo(p.periodo), ...fDimensiones(p)];
  return partes.map((x) => "    " + x).join(",\n");
}

/**
 * `ROW(...)` con las medidas que el modelo realmente tiene.
 * Las que faltan no se piden: el informe después saltea esa tarjeta.
 */
function filaMedidas(claves) {
  const usables = claves.filter((k) => m(k));
  if (!usables.length) return null;
  return usables.map((k) => `      "${k}", ${m(k)}`).join(",\n");
}

/** `"clave", Medida` para SUMMARIZECOLUMNS, salteando lo no mapeado. */
function colsMedidas(claves) {
  return claves.filter((k) => m(k)).map((k) => `    "${k}", ${m(k)}`);
}

/**
 * De qué tabla es un filtro. Todos los que arma este módulo tienen la forma
 * `FILTER(ALL(Tabla), ...)`, así que sale de leerlo; si algún día no la tiene,
 * devuelve null y el filtro se conserva siempre, que es lo prudente.
 */
function tablaDeFiltro(dax) {
  const m = /^\s*FILTER\(\s*ALL\(\s*('(?:[^']|'')+'|[A-Za-z\u00C0-\u00ff_][\w\u00C0-\u00ff]*)\s*\)/.exec(String(dax || ""));
  return m ? pelarTabla(m[1]) : null;
}

/**
 * El nombre desnudo de una tabla. En DAX, `'Aging - Actualizado'` y
 * `Ventas` son la misma clase de cosa escritas distinto, y el modelo
 * semántico las nombra sin comillas: sin igualar las dos formas, ningún
 * filtro llegaba a compararse con su tabla y no se descartaba nada.
 */
function pelarTabla(n) {
  const s = String(n || "").trim();
  return /^'.*'$/.test(s) ? s.slice(1, -1).replace(/''/g, "'") : s;
}

/**
 * Los filtros que esta consulta tiene derecho a aplicar.
 *
 * Un filtro sobre una tabla que no llega a la medida no la cambia: en el mejor
 * caso es un escaneo caro de más, y en el peor vacía el resultado. El caso que
 * lo hizo evidente: las exclusiones del aging —clase de documento, orden de
 * pago, documentos sueltos— metidas en las consultas de facturación, que salen
 * de otra tabla y no tienen relación con esa.
 *
 * Se conserva el filtro cuando:
 *   · mueve a alguna de las medidas de la consulta, según midió `semantica`; o
 *   · es de la misma tabla por la que se está agrupando, porque ahí no filtra
 *     el número sino la lista de filas; o
 *   · no hay medición, y entonces no se toca nada.
 */
function aplicables(filtros, medidas, alcance, columnasGrupo) {
  const lista = (filtros || []).filter(Boolean);
  if (!alcance || !Object.keys(alcance).length) return lista;
  const claves = (medidas || []).filter((k) => m(k) && alcance[k]);
  if (!claves.length) return lista;

  const tablasGrupo = new Set((columnasGrupo || []).filter(Boolean).map((x) => pelarTabla(tablaDe(x))));
  return lista.filter((dax) => {
    const t = tablaDeFiltro(dax);
    if (!t) return true;
    if (tablasGrupo.has(t)) return true;
    // si de alguna medida no sabemos nada, no descartamos
    return claves.some((k) => alcance[k][t] !== false);
  });
}

/**
 * Con qué se abre cada medida en ESTA apertura.
 *
 * Una medida puede ser sorda a la tabla por la que se la está abriendo. Pasa
 * siempre que lleva un argumento de tabla —`CALCULATE(SUM(T[c]), T)`— que le
 * saca los filtros de su propia tabla: agrupada por una columna de T devuelve
 * el total entero en CADA fila, y la apertura muestra cuarenta y cinco veces
 * el mismo número como si fueran cuarenta y cinco datos distintos.
 *
 * Cuando eso pasa se suma la columna que hay detrás de la medida, que sí
 * responde. Y si no se sabe cuál es, se devuelve null: mejor no ofrecer la
 * apertura que ofrecerla mintiendo.
 */
function sustituciones(dims, medidas, alcance, columna, expresiones) {
  const usa = { ...(expresiones || {}) };
  if (!alcance || !Object.keys(alcance).length) return usa;
  const tablas = [...new Set(dims.map((x) => pelarTabla(tablaDe(x))))];

  for (const k of medidas || []) {
    if (usa[k] || !m(k) || !alcance[k]) continue;
    const sorda = tablas.some((t) => alcance[k][t] === false);
    if (!sorda) continue;
    const crudo = (columna || {})[k];
    if (crudo) usa[k] = "SUM(" + crudo + ")";
    else usa[k] = null;                     // marca: esta medida no sirve acá
  }
  // si NINGUNA medida quedó utilizable, la apertura entera no tiene sentido.
  // Las marcadas con null quedan así: `desglose` las saltea, y cada una que
  // se saltea es una columna que habría mostrado el total repetido.
  const utiles = (medidas || []).filter((k) => usa[k] !== null && (usa[k] || m(k)));
  return utiles.length ? usa : null;
}

/**
 * Una apertura: la medida abierta por una o más columnas.
 *
 * Es el ladrillo de todo el detalle del tablero de deuda. Devuelve null si el
 * modelo no tiene alguna de las piezas, para que el informe saltee esa vista
 * en vez de fallar.
 *
 *   desglose({ por: [c("concepto")], medidas: ["deudaFacturacion"], tope: 40 })
 */
function desglose({ por, medidas, filtros = [], tope = 0, orden = null, desc = true,
                    alcance = null, expresiones = null, columna = null }) {
  const dims = (Array.isArray(por) ? por : [por]).filter(Boolean);
  const usa = sustituciones(dims, medidas, alcance, columna, expresiones);
  if (usa === null) return null;             // sorda y sin columna detrás
  // `usa` reemplaza la referencia de una medida por otro DAX cuando hace falta
  const cols = (medidas || []).filter((k) => usa[k] !== null && (usa[k] || m(k)))
    .map((k) => `    "${k}", ${usa[k] || m(k)}`);
  if (!dims.length || !cols.length) return null;

  const cuerpo = [
    ...dims.map((x) => "    " + x),
    ...aplicables(filtros, medidas, alcance, dims).map((x) => "    " + x),
    ...cols
  ].join(",\n");

  // el orden por defecto es la primera medida que el modelo sí tiene
  const clave = orden || (medidas || []).find((k) => usa[k] !== null && (usa[k] || m(k)));
  const porOrden = clave ? `\n  ORDER BY [${clave}] ${desc ? "DESC" : "ASC"}` : "";

  const tabla = `SUMMARIZECOLUMNS(\n${cuerpo}\n  )`;
  return tope
    ? `\nEVALUATE\n  TOPN(\n    ${tope},\n  ${tabla.replace(/\n/g, "\n  ")},\n    [${clave}], ${desc ? "DESC" : "ASC"}\n  )${porOrden}`
    : `\nEVALUATE\n  ${tabla}${porOrden}`;
}

/**
 * Las exclusiones fijas del tablero: lo que el informe filtra SIEMPRE y nunca
 * se ofrece como segmentador.
 *
 * Un tablero de producción casi nunca mira el modelo entero —«sólo el canal
 * 32, sociedad IHSA, estas clases de documento»— y esas reglas viven en el
 * tablero, no en el modelo. Replicarlas acá es la diferencia entre un informe
 * que da los mismos números que la pantalla de Power BI y uno que da otros.
 *
 * Cada regla es {campo, igual|contiene|incluir|excluir}. Todos los valores
 * pasan por lit(), así que nada de lo que se escriba acá entra crudo en el DAX.
 */
function fExclusiones(reglas) {
  const partes = [];
  for (const r of reglas || []) {
    /* La orden de pago: la clase «AB» sólo cuenta si la tiene, y las demás
       clases sólo si NO la tienen. Es una sola condición con dos ramas, no dos
       filtros: separarlas dejaría fuera todo. */
    if (r.tipo === "ordenDePago") {
      const clase = c(r.campo), txt = c(r.texto);
      if (!clase || !txt) continue;
      partes.push(`FILTER(ALL(${tablaDe(clase)}), IF(${clase} = ${lit(r.claseConMarca)}, ` +
        `CONTAINSSTRING(${txt}, ${lit(r.marca)}), NOT(CONTAINSSTRING(${txt}, ${lit(r.marca)}))))`);
      continue;
    }
    // el mismo id puede estar en una columna o en otra: se excluye si aparece
    if (Array.isArray(r.campos)) {
      const cols = r.campos.map(c).filter(Boolean);
      if (!cols.length) continue;
      const cond = cols.map((x) => `${x} IN {${r.excluir.map(lit).join(", ")}}`).join(" || ");
      partes.push(`FILTER(ALL(${tablaDe(cols[0])}), NOT(${cond}))`);
      continue;
    }
    const col = c(r.campo);
    if (!col) continue;
    const t = tablaDe(col);
    if (r.igual != null && r.igual !== "") {
      partes.push(`FILTER(ALL(${t}), ${col} = ${lit(r.igual)})`);
    } else if (r.contiene) {
      // tolera «Petroleras» vs «Petróleo»: el rótulo exacto de una dimensión
      // cambia sin avisar y no vale la pena romper el informe por una tilde
      partes.push(`FILTER(ALL(${t}), CONTAINSSTRING(${col}, ${lit(r.contiene)}))`);
    } else if (Array.isArray(r.incluir) && r.incluir.length) {
      partes.push(`FILTER(ALL(${t}), ${col} IN {${r.incluir.map(lit).join(", ")}})`);
    } else if (Array.isArray(r.excluir) && r.excluir.length) {
      partes.push(`FILTER(ALL(${t}), NOT(${col} IN {${r.excluir.map(lit).join(", ")}}))`);
    }
  }
  return partes;
}

/** Cómo se lee una exclusión, para mostrarla en el informe. */
function textoExclusion(r, rotulo) {
  if (r.tipo === "ordenDePago") {
    return `Documentos ${r.claseConMarca}: sólo con ${r.marca} · el resto: sólo sin ${r.marca}`;
  }
  if (Array.isArray(r.campos)) {
    return `${rotulo || "Documento"} excluido: ${r.excluir.join(", ")}`;
  }
  const q = rotulo || r.campo;
  if (r.igual != null && r.igual !== "") return `${q}: ${r.igual}`;
  if (r.contiene) return `${q}: contiene «${r.contiene}»`;
  if (Array.isArray(r.incluir)) return `${q}: sólo ${r.incluir.join(", ")}`;
  if (Array.isArray(r.excluir)) return `${q}: todo menos ${r.excluir.join(", ")}`;
  return q;
}

/**
 * Excluye un tramo del aging de las consultas de cobranza.
 *
 * «A vencer» no es deuda en el sentido de gestión —todavía no venció— pero sí
 * suma al saldo. Que entre o no cambia el total, así que la decisión es del
 * que lee, no del informe.
 */
function fSinTramo(etiquetas) {
  const col = c("agingTramo");
  if (!col || !etiquetas || !etiquetas.length) return null;
  const vals = etiquetas.map(lit).join(", ");
  return `FILTER(ALL(${tablaDe(col)}), NOT(${col} IN {${vals}}))`;
}

/** Los valores distintos de una columna, para saber si el tablero ya la filtró. */
function valoresDe(col, tope = 12) {
  if (!col) return null;
  return `\nEVALUATE\n  TOPN(${tope}, SUMMARIZECOLUMNS(${col}))`;
}

module.exports = {
  m, c, tablaDe, lit, claveMes, ventanaMeses, valorPeriodo,
  fPeriodo, fVentana, fDimensiones, argsFiltro, filaMedidas, colsMedidas,
  desglose, valoresDe, fSinTramo, fMeses, fExclusiones, textoExclusion,
  aplicables, tablaDeFiltro, pelarTabla
};
