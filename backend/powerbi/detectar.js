"use strict";
/**
 * Deduce el mapeo del modelo sin que nadie escriba nombres a mano.
 *
 * Por dos caminos, y el bueno es el primero:
 *
 *   · POR INVENTARIO. `COLUMNSTATISTICS()` devuelve, en una sola consulta,
 *     todas las tablas y columnas del modelo con su cardinalidad. Con eso no
 *     hay nada que adivinar: `mapeo.js` clasifica lo que REALMENTE hay. Un
 *     tablero cuyas tablas se llamen de cualquier forma funciona igual.
 *
 *   · POR SONDEO, si el modelo no deja correr esa función. Ahí se vuelve a lo
 *     de antes: probar `EVALUATE TOPN(1, Tabla)` contra un diccionario de
 *     nombres habituales y cortar en el primer acierto.
 *
 * Las medidas se buscan por nombre en los dos casos —no hay forma de
 * listarlas sin XMLA— y lo que no aparece se arma sumando la columna que
 * corresponda, así un modelo sin una sola medida escrita también sirve.
 */
const { consultar } = require("./client");
const { TABLAS, COLUMNAS, MEDIDAS, COLUMNA_DE } = require("./candidatos");
const SEMANTICA = require("./semantica");
const MAPEO = require("./mapeo");

const CONCURRENCIA = 4;
// La API corta en 120 consultas por minuto y por usuario. Un recorrido entero
// tiene que caber en ese presupuesto, con margen para lo que venga después.
const TOPE = 105;

/** Corre tareas con un límite de simultáneas, cortando si algo pide parar. */
async function enTanda(tareas, limite) {
  const salida = [];
  let i = 0;
  const obreros = Array.from({ length: Math.min(limite, tareas.length) }, async () => {
    while (i < tareas.length) {
      const mio = i++;
      salida[mio] = await tareas[mio]();
    }
  });
  await Promise.all(obreros);
  return salida;
}

/** `Mi Tabla` necesita comillas simples en DAX; `Ventas` no. */
const refTabla = (n) => (/^[A-Za-zÀ-ÿ_][\wÀ-ÿ]*$/.test(n) ? n : "'" + n.replace(/'/g, "''") + "'");
const refColumna = (tabla, col) => refTabla(tabla) + "[" + col + "]";

/**
 * Una prueba: acierta, no existe, o el modelo pidió bajar el ritmo. Ese
 * último caso no se puede confundir con "no existe": daría por ausente algo
 * que sí está.
 */
async function probar(ws, ds, dax, gasto) {
  if (gasto.n >= TOPE || gasto.frenado) return null;
  gasto.n++;
  try {
    return await consultar(ws, ds, dax);
  } catch (e) {
    if (e.status === 429) { gasto.frenado = true; }
    return null;
  }
}

/** ¿Existe esta tabla? Si existe, devuelve además sus columnas y una fila. */
async function probarTabla(ws, ds, nombre, gasto) {
  const filas = await probar(ws, ds, `EVALUATE TOPN(1, ${refTabla(nombre)})`, gasto);
  if (!filas) return null;
  return { nombre, columnas: filas.length ? Object.keys(filas[0]) : [], muestra: filas[0] || {} };
}

/** ¿Existe esta medida? */
async function probarMedida(ws, ds, nombre, gasto) {
  const filas = await probar(ws, ds, `EVALUATE ROW("v", [${nombre}])`, gasto);
  if (!filas) return null;
  return { nombre, valor: filas.length ? Object.values(filas[0])[0] : null };
}

/** ¿El valor de esta columna parece un mes? Devuelve el formato o null. */
function formatoDeMes(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v >= 190001 && v <= 299912 ? "numero" : null;
  const s = String(v).trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return "texto";
  if (/^\d{4}(0[1-9]|1[0-2])$/.test(s)) return "numero";
  return null;
}

/**
 * Busca, dentro de las columnas de una tabla, la que encaje con un patrón.
 * Para el período además se exige que el valor de muestra parezca un mes:
 * "Mes Número" (10) coincide por nombre pero no sirve.
 */
function elegirColumna(tabla, patron, exigirMes) {
  const patrones = COLUMNAS[patron] || [];
  const corto = (c) => { const m = c.match(/\[([^\]]+)\]\s*$/); return m ? m[1] : c; };
  for (const re of patrones) {
    for (const cruda of tabla.columnas) {
      const nombre = corto(cruda);
      if (!re.test(nombre)) continue;
      if (exigirMes && !formatoDeMes(tabla.muestra[cruda])) continue;
      return { columna: nombre, formato: exigirMes ? formatoDeMes(tabla.muestra[cruda]) : null };
    }
  }
  // para el período, un último intento: cualquier columna cuyo VALOR sea un mes
  if (exigirMes) {
    for (const cruda of tabla.columnas) {
      const f = formatoDeMes(tabla.muestra[cruda]);
      if (f) return { columna: corto(cruda), formato: f };
    }
  }
  return null;
}

/** Las medidas del modelo, buscadas por nombre. Es lo único que no se puede
 *  listar: ni COLUMNSTATISTICS ni ninguna función DAX enumera medidas. */
async function buscarMedidas(ws, ds, gasto, prioridad) {
  const encontradas = {}, sinEncontrar = [];
  /* El presupuesto de consultas es finito, así que el orden decide qué se
     alcanza a mirar. Primero lo que el informe elegido va a usar: buscar en
     orden alfabético hacía que se gastara entero en medidas de otro informe
     y las de éste quedaran sin encontrar. */
  const pedidos = (prioridad || []).filter((k) => MEDIDAS[k]);
  const papeles = [...new Set([...pedidos, ...Object.keys(MEDIDAS)])];
  await enTanda(papeles.map((papel) => async () => {
    for (const nombre of MEDIDAS[papel]) {
      const m = await probarMedida(ws, ds, nombre, gasto);
      if (m) { encontradas[papel] = m.nombre; return; }
    }
    sinEncontrar.push(papel);
  }), CONCURRENCIA);
  return { encontradas, sinEncontrar };
}

/**
 * El camino bueno: con el inventario en la mano no se adivina nada.
 */
async function porInventario(ws, ds, tablas, prioridad) {
  const gasto = { n: 0, frenado: false };
  const deColumnas = MAPEO.columnas(tablas);
  const { encontradas, sinEncontrar } = await buscarMedidas(ws, ds, gasto, prioridad);

  const medidas = {};
  for (const papel of Object.keys(MEDIDAS)) {
    medidas[papel] = encontradas[papel] ? "[" + encontradas[papel] + "]" : "";
  }
  // lo que no apareció, se arma sumando la columna que corresponda
  const armadas = MAPEO.medidasSinteticas(tablas, deColumnas.perfil, encontradas, deColumnas.columnas);
  for (const [k, expr] of Object.entries(armadas)) if (!medidas[k]) medidas[k] = expr;

  const propuesta = { medidas, columnas: {}, periodoFormato: deColumnas.periodoFormato };
  for (const clave of Object.keys(COLUMNA_DE)) propuesta.columnas[clave] = "";
  for (const [k, v] of Object.entries(deColumnas.columnas)) propuesta.columnas[k] = v;

  return {
    via: "inventario",
    propuesta,
    consultas: gasto.n + 1,
    frenado: gasto.frenado,
    tope: false,
    // lo que el Power Query ya dejó recortado: contexto, no segmentador
    yaFiltrado: deColumnas.yaFiltrado,
    armadas: Object.keys(armadas),
    encontrado: {
      tablas: Object.fromEntries(Object.entries(deColumnas.perfil)
        .map(([n, p]) => [n, { nombre: n, columnas: p.columnas }])),
      medidas: encontradas
    },
    sinEncontrar: { tablas: [], medidas: sinEncontrar },
    columnasPorTabla: Object.fromEntries(Object.values(tablas)
      .map((t) => [t.nombre, t.columnas.map((c) => c.nombre)]))
  };
}

/**
 * El recorrido completo. Devuelve un mapeo propuesto y el detalle de qué se
 * encontró, para que la pantalla pueda mostrarlo y el usuario confirme.
 */
async function detectar(ws, ds, prioridad) {
  let tablas = null;
  try { tablas = await SEMANTICA.inventario(ws, ds); }
  catch (e) {
    console.warn("[detectar] el modelo no deja leer el inventario (" + e.message +
      "); voy por sondeo de nombres");
  }
  if (tablas && Object.keys(tablas).length) return porInventario(ws, ds, tablas, prioridad);
  const r = await porSondeo(ws, ds, prioridad);
  return { ...r, via: "sondeo" };
}

/**
 * El camino de respaldo: probar nombres habituales de tabla hasta acertar.
 */
async function porSondeo(ws, ds, prioridad) {
  const gasto = { n: 0, frenado: false };
  const hallazgos = { tablas: {}, medidas: {}, sinEncontrar: { tablas: [], medidas: [] } };

  // ── tablas: el primer acierto de cada papel, y con él todas sus columnas
  const papelesTabla = Object.keys(TABLAS);
  await enTanda(papelesTabla.map((papel) => async () => {
    for (const nombre of TABLAS[papel]) {
      const t = await probarTabla(ws, ds, nombre, gasto);
      if (t) { hallazgos.tablas[papel] = t; return; }
    }
    hallazgos.sinEncontrar.tablas.push(papel);
  }), CONCURRENCIA);

  // ── medidas: idem, cortando en el primer acierto, lo del informe primero
  const papelesMedida = [...new Set([...(prioridad || []).filter((k) => MEDIDAS[k]),
                                     ...Object.keys(MEDIDAS)])];
  await enTanda(papelesMedida.map((papel) => async () => {
    for (const nombre of MEDIDAS[papel]) {
      const m = await probarMedida(ws, ds, nombre, gasto);
      if (m) { hallazgos.medidas[papel] = m; return; }
    }
    hallazgos.sinEncontrar.medidas.push(papel);
  }), CONCURRENCIA);

  // ── armar la propuesta
  const propuesta = { medidas: {}, columnas: {}, periodoFormato: "numero" };
  for (const papel of papelesMedida) {
    propuesta.medidas[papel] = hallazgos.medidas[papel] ? "[" + hallazgos.medidas[papel].nombre + "]" : "";
  }
  for (const [clave, cfg] of Object.entries(COLUMNA_DE)) {
    propuesta.columnas[clave] = "";
    // en un modelo de cobranzas, cliente, gestor o sociedad suelen vivir en la
    // tabla de aging y no en una dimensión propia: se prueba también ahí
    const intentos = [[cfg.tabla, cfg.patron]];
    if (cfg.alterna) intentos.push([cfg.alterna, cfg.altPatron || cfg.patron]);
    for (const [papel, patron] of intentos) {
      const t = hallazgos.tablas[papel];
      if (!t) continue;
      const c = elegirColumna(t, patron, clave === "periodo");
      if (!c) continue;
      propuesta.columnas[clave] = refColumna(t.nombre, c.columna);
      if (clave === "periodo" && c.formato) propuesta.periodoFormato = c.formato;
      break;
    }
  }

  return {
    propuesta,
    consultas: gasto.n,
    // si Power BI cortó por frecuencia, lo no encontrado no es concluyente
    frenado: gasto.frenado,
    tope: gasto.n >= TOPE,
    encontrado: {
      tablas: Object.fromEntries(Object.entries(hallazgos.tablas)
        .map(([k, t]) => [k, { nombre: t.nombre, columnas: t.columnas.length }])),
      medidas: Object.fromEntries(Object.entries(hallazgos.medidas)
        .map(([k, m]) => [k, m.nombre]))
    },
    sinEncontrar: hallazgos.sinEncontrar,
    // las columnas crudas sirven para elegir a mano si la propuesta no acierta
    columnasPorTabla: Object.fromEntries(Object.entries(hallazgos.tablas)
      .map(([k, t]) => [t.nombre, t.columnas.map((c) => {
        const m = c.match(/\[([^\]]+)\]\s*$/); return m ? m[1] : c;
      })]))
  };
}

module.exports = { detectar, formatoDeMes, refTabla, refColumna };
