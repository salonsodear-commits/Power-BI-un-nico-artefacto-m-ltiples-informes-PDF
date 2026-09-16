"use strict";
/**
 * Deduce el mapeo del modelo sin que nadie escriba nombres a mano.
 *
 * executeQueries sólo admite DAX estándar: ni funciones INFO ni DMV, así que
 * no hay forma de pedir "listame las tablas". Lo que sí se puede es probar:
 * `EVALUATE TOPN(1, Tabla)` acierta o falla, y cuando acierta devuelve TODAS
 * las columnas de esa tabla de una sola vez. Con las medidas pasa lo mismo
 * con `EVALUATE ROW("v", [Medida])`.
 *
 * Así que se prueba contra un diccionario de nombres habituales, ordenado de
 * más probable a menos, cortando en el primer acierto de cada campo.
 */
const { consultar } = require("./client");
const { TABLAS, COLUMNAS, MEDIDAS, COLUMNA_DE } = require("./candidatos");

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

/**
 * El recorrido completo. Devuelve un mapeo propuesto y el detalle de qué se
 * encontró, para que la pantalla pueda mostrarlo y el usuario confirme.
 */
async function detectar(ws, ds) {
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

  // ── medidas: idem, cortando en el primer acierto
  const papelesMedida = Object.keys(MEDIDAS);
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
    const t = hallazgos.tablas[cfg.tabla];
    propuesta.columnas[clave] = "";
    if (!t) continue;
    const c = elegirColumna(t, cfg.patron, clave === "periodo");
    if (!c) continue;
    propuesta.columnas[clave] = refColumna(t.nombre, c.columna);
    if (clave === "periodo" && c.formato) propuesta.periodoFormato = c.formato;
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
