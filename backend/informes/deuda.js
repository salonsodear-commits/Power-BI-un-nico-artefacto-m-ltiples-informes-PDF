"use strict";
/**
 * Informe de Deuda y Cobranzas.
 *
 * Único informe con DOS salidas de la misma consulta:
 *   · `tablero`   — la vista interactiva: solapas, buscador, orden, filtros.
 *   · `secciones` — las hojas A4 que salen por impresora.
 * Se arman juntas para que el PDF sea exactamente lo que se estaba mirando y
 * no una segunda consulta que puede diferir.
 *
 * Semántica del tablero de origen, respetada acá:
 *   · La cartera es una FOTO, no un acumulado mensual: los totales y el aging
 *     no llevan filtro de período. Filtrar por mes recortaría a las facturas
 *     que vencen en ese mes, que es otra cosa.
 *   · Cobranza (aging de SAP) y Facturación (provisión no facturada) son dos
 *     universos distintos que sólo se suman en la exposición combinada.
 *   · Lo que el Power Query ya dejó filtrado —una sola sociedad, un solo
 *     canal— no se vuelve a ofrecer como filtro: se muestra como contexto.
 */
const { consultarVarias } = require("../powerbi/client");
const MODELO = require("../modelo");
const Q = require("../powerbi/queries");
const { limpiar, kpi, etiquetaMes } = require("./comun");
const { nombreCorto, refs } = require("./ejecutivo");

const meta = {
  nombre: "Deuda",
  titulo: "Informe de Deuda y Cobranzas",
  bajada: "Cartera por tramo de vencimiento, concentración por cliente y exposición al riesgo.",
  fuente: "Power BI — Deuda"
};


const TOPE_CONSULTA = 300;   // lo que viaja
const TOPE_IMPRESO = 8;      // lo que entra en una hoja sin volverse ilegible

/**
 * Los cortes de cada consulta: primero lo que el tablero recorta siempre
 * —canal, clases de documento— y después lo que el usuario eligió. Sin las
 * exclusiones fijas, los totales no coinciden con la pantalla de Power BI.
 */
const cortes = (p) => [
  ...Q.fExclusiones(p.exclusiones || MODELO.leer().exclusiones),
  ...Q.fDimensiones(p),
  // sin meses elegidos, la cartera va entera: es una foto a la fecha
  Q.fMeses(p.meses)
].filter(Boolean);

/**
 * Cómo se reconoce el tramo «a vencer» sin escribirlo a mano: cada modelo lo
 * rotula distinto («A VENCER», «No vencido», «Por vencer»). Se decide sobre los
 * valores reales que devolvió el aging, no sobre una lista fija.
 */
const ES_A_VENCER = /^\s*(a\s*vencer|no\s*vencid|por\s*vencer|corriente|sin\s*vencim)/i;

/**
 * Los filtros de las consultas de COBRANZA. Se separan de los de facturación
 * porque «a vencer» es un tramo del aging y la provisión no lo tiene.
 */
function cortesCobranza(p, tramosAVencer) {
  const f = cortes(p);
  if (p.incluirAVencer === false && tramosAVencer.length) {
    const sin = Q.fSinTramo(tramosAVencer);
    if (sin) f.push(sin);
  }
  return f;
}

/* ══ consultas ═══════════════════════════════════════════════════════════
   Cada una es opcional: si el modelo no tiene la columna, `desglose`
   devuelve null y la vista correspondiente no se arma. */
function consultas(p, tramosAVencer) {
  const q = {};
  const f = cortes(p);                                   // vale para todo
  const fCob = cortesCobranza(p, tramosAVencer || []);   // + el corte de «a vencer»

  // Las tarjetas se arman con DOS consultas, no una: el total de cobranza
  // tiene que poder excluir «a vencer» y el de facturación no se entera de
  // ese tramo, porque la provisión no lo tiene.
  const filaCob = Q.filaMedidas(["deudaCobranza", "deudaVencida", "clientesActivos"]);
  if (filaCob) q.kpisCobranza = envuelto(filaCob, fCob);
  const filaFac = Q.filaMedidas(["deudaFacturacion", "importeFacturado"]);
  if (filaFac) q.kpisFacturacion = envuelto(filaFac, f);

  // ── aging: el de cobranza y el de facturación son medidas distintas ──
  //    uno sale del aging de cobranzas, el otro de la provisión.
  //    Lleva el corte de «a vencer» como todo lo demás: en el tablero, sacar
  //    ese tramo le saca también la columna al aging, y el informe tiene que
  //    mostrar lo mismo que la pantalla.
  q.tramos = Q.desglose({ por: Q.c("agingTramo"), filtros: fCob,
    medidas: ["deudaCobranza", "deudaVencida"] });
  q.tramosFact = Q.desglose({ por: Q.c("tramoFacturacion"), filtros: f,
    medidas: ["deudaFacturacion"] });

  // ── cortes de cartera ────────────────────────────────────────────────
  q.negocioCob = Q.desglose({ por: Q.c("vertical"), filtros: fCob, medidas: ["deudaCobranza"] });
  q.negocioFac = Q.desglose({ por: Q.c("vertical"), filtros: f,    medidas: ["deudaFacturacion"] });
  q.canal   = Q.desglose({ por: Q.c("canal"),      filtros: fCob, medidas: ["deudaCobranza"] });
  q.gestor  = Q.desglose({ por: Q.c("clienteKam"), filtros: fCob, medidas: ["deudaCobranza", "deudaVencida"] });

  // ── aperturas del detalle: lo que «ver datos» tiene para mostrar ─────
  //    cada una con los filtros de SU universo
  q.claseDoc  = Q.desglose({ por: Q.c("claseDocumento"),   filtros: fCob, medidas: ["deudaCobranza"] });
  q.tipoDeuda = Q.desglose({ por: Q.c("tipoDeuda"),        filtros: fCob, medidas: ["deudaCobranza"] });
  q.estadoVto = Q.desglose({ por: Q.c("estadoVencimiento"),filtros: fCob, medidas: ["deudaCobranza"] });
  q.condPago  = Q.desglose({ por: Q.c("condicionPago"),    filtros: fCob, medidas: ["deudaCobranza"] });
  q.concepto  = Q.desglose({ por: Q.c("concepto"),         filtros: f, medidas: ["deudaFacturacion", "importeFacturado"], tope: 40 });
  q.tipoProv  = Q.desglose({ por: Q.c("tipoProvision"),    filtros: f, medidas: ["deudaFacturacion"] });
  q.statusFac = Q.desglose({ por: Q.c("statusPendiente"),  filtros: f, medidas: ["deudaFacturacion"] });

  /* ── por cliente ───────────────────────────────────────────────────────
     Las dos caras van en consultas SEPARADAS, y es la diferencia entre un
     número correcto y uno inventado.

     Las relaciones del modelo son Aging→Clientes y Provision→Clientes, en un
     solo sentido, y [Deuda Facturacion] además ignora los filtros sobre su
     propia tabla. Agrupar cobranza y facturación juntas por una columna del
     aging hacía que la facturación devolviera el mismo valor para CADA
     combinación, y SUMMARIZECOLUMNS conserva toda fila con alguna medida no
     vacía: salía el producto cruzado, con cada cliente mostrando las razones
     sociales de todos los demás. */
  q.clientesCobranza = Q.desglose({
    por: [Q.c("clienteNombre"), Q.c("clienteRazon"), Q.c("clienteKam")].filter(Boolean),
    filtros: fCob, medidas: ["deudaCobranza", "deudaVencida"], tope: TOPE_CONSULTA });
  q.clientesFacturacion = Q.desglose({
    por: Q.c("clienteNombre"), filtros: f,
    medidas: ["deudaFacturacion", "importeFacturado"], tope: TOPE_CONSULTA });
  // el aging de cada cliente, para la barrita de la tabla
  q.clienteTramo = Q.desglose({ por: [Q.c("clienteNombre"), Q.c("agingTramo")], filtros: fCob,
    medidas: ["deudaCobranza"] });
  // lo pendiente de facturar, abierto por cliente y concepto
  q.clienteConcepto = Q.desglose({ por: [Q.c("clienteNombre"), Q.c("concepto")], filtros: f,
    medidas: ["deudaFacturacion"], tope: 400 });

  /* La apertura mensual: en qué mes cayó cada peso pendiente de facturar.
     Es lo que el tablero abre al tocar «+» en un cliente, y la única forma de
     ver que el 74 % del acumulado es trabajo del mes corriente y no atraso. */
  if (Q.c("anioProvision") && Q.c("mesProvision")) {
    q.clienteMes = Q.desglose({
      por: [Q.c("clienteNombre"), Q.c("anioProvision"), Q.c("mesProvision")],
      filtros: f, medidas: ["deudaFacturacion"], tope: 900 });
  }

  /* Las observaciones viven en una hoja de SharePoint sin relación con el
     modelo, así que se traen enteras y se unen por nombre de cliente acá.
     Sin medida: SUMMARIZECOLUMNS sobre dos columnas devuelve las combinaciones
     que existen, que es justo la lista. */
  if (Q.c("obsCliente") && Q.c("obsTexto")) {
    q.observaciones = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("obsCliente")},\n` +
      `    ${Q.c("obsTexto")}\n  )`;
  }

  // ── DSO: suele vivir en su propia tabla, sin relación con el calendario ─
  if (Q.m("dso") && Q.c("dsoPeriodo")) {
    // El DSO vive en su propia tabla, sin relación con el calendario: la serie
    // viene entera y el informe se queda con el último período. Elegir meses
    // sí lo acota, porque ahí se está preguntando por esos meses.
    const fDso = (p.meses || []).length ? Q.fMeses(p.meses) : null;
    q.dso = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("dsoPeriodo")},\n` +
      (fDso ? `    ${fDso},\n` : "") +
      `    "dso", ${Q.m("dso")}\n  )\n  ORDER BY ${Q.c("dsoPeriodo")}`;
  } else if (Q.m("dso")) {
    q.dsoSuelto = `\nEVALUATE\n  ROW("dso", ${Q.m("dso")})`;
  }

  for (const k of Object.keys(q)) if (!q[k]) delete q[k];
  return q;
}

/** ROW(...) con o sin CALCULATETABLE, según haya filtros que aplicar. */
function envuelto(fila, filtros) {
  const dims = (filtros || []).map((x) => "    " + x);
  return dims.length
    ? `\nEVALUATE\n  CALCULATETABLE(\n    ROW(\n${fila}\n    ),\n${dims.join(",\n")}\n  )`
    : `\nEVALUATE\n  ROW(\n${fila}\n  )`;
}

/* ══ armado ══════════════════════════════════════════════════════════════ */

async function construir(p) {
  // Para excluir «a vencer» hay que saber cómo lo rotula ESTE modelo, así que
  // primero se pregunta. Sólo cuando hace falta: incluirlo es lo normal y no
  // merece un viaje de ida y vuelta extra en cada carga.
  let tramosAVencer = [];
  if (p.incluirAVencer === false && Q.c("agingTramo")) {
    const previa = await consultarVarias(p.workspaceId, p.datasetId, {
      t: Q.desglose({ por: Q.c("agingTramo"), medidas: ["deudaCobranza"] }) });
    const col = nombreCorto(Q.c("agingTramo"));
    tramosAVencer = (previa.t || [])
      .map((f) => etiquetaDe(f[col]))
      .filter((x) => x && ES_A_VENCER.test(x));
  }

  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p, tramosAVencer));
  // Las tarjetas se juntan de los dos universos; la exposición total es la
  // suma de lo que quedó, no una medida aparte que ignoraría el corte.
  const k = Object.assign({}, (d.kpisCobranza || [])[0], (d.kpisFacturacion || [])[0]);
  if (typeof k.deudaCobranza === "number" || typeof k.deudaFacturacion === "number") {
    k.deudaTotal = (k.deudaCobranza || 0) + (k.deudaFacturacion || 0);
  }
  if (typeof k.deudaVencida === "number" && k.deudaTotal) {
    k.indiceRiesgo = (k.deudaVencida / k.deudaTotal) * 100;
  }

  const colCli  = nombreCorto(Q.c("clienteNombre"));
  const colRazon= Q.c("clienteRazon") ? nombreCorto(Q.c("clienteRazon")) : null;
  const colKam  = Q.c("clienteKam")   ? nombreCorto(Q.c("clienteKam"))   : null;
  const colTramo= Q.c("agingTramo")   ? nombreCorto(Q.c("agingTramo"))   : null;
  const colConc = Q.c("concepto")     ? nombreCorto(Q.c("concepto"))     : null;

  const vencidaPct = typeof k.deudaVencida === "number" && k.deudaTotal
    ? (k.deudaVencida / k.deudaTotal) * 100 : undefined;

  /* ── DSO ─────────────────────────────────────────────────────────── */
  const colDso = Q.c("dsoPeriodo") ? nombreCorto(Q.c("dsoPeriodo")) : null;
  const serieDso = (d.dso || [])
    .filter((f) => typeof f.dso === "number" && f[colDso] !== undefined && f[colDso] !== null)
    .sort((a, b) => String(a[colDso]).localeCompare(String(b[colDso])));
  const ultimoDso = serieDso.length ? serieDso[serieDso.length - 1]
    : ((d.dsoSuelto || [])[0] || null);
  const dsoValor = ultimoDso ? ultimoDso.dso : undefined;
  const dsoPeriodo = serieDso.length ? etiquetaMes(ultimoDso[colDso]) : null;
  const dsoPorAnio = promediosPorAnio(serieDso, colDso);

  /* ── rankings simples ────────────────────────────────────────────── */
  // Se suma por etiqueta: si el modelo devuelve la misma categoría en varias
  // filas —pasa cuando la consulta agrupa por algo más— listar el rótulo dos
  // veces con dos montos es peor que sumarlos.
  const ranking = (filas, col, valor) => sumarPorEtiqueta([(filas || [])
    .map((f) => ({ etiqueta: etiquetaDe(f[nombreCorto(col)]), valor: f[valor] }))
    .filter((x) => x.etiqueta !== null && typeof x.valor === "number")])
    .filter((x) => x.valor !== 0);

  const tramos     = ordenarTramos(ranking(d.tramos, Q.c("agingTramo"), "deudaCobranza"));
  const tramosFact = Q.c("tramoFacturacion")
    ? ordenarTramos(ranking(d.tramosFact, Q.c("tramoFacturacion"), "deudaFacturacion")) : [];
  // El negocio se suma de los dos universos, que vinieron por separado
  // justamente para que cada uno lleve los filtros que le corresponden.
  const negocio = sumarPorEtiqueta([
    ranking(d.negocioCob, Q.c("vertical"), "deudaCobranza"),
    ranking(d.negocioFac, Q.c("vertical"), "deudaFacturacion")
  ]).sort((a, b) => b.valor - a.valor);
  const canal = ranking(d.canal, Q.c("canal"), "deudaCobranza");

  /* ── clientes: la fila rica que alimenta las tres solapas ────────── */
  const agingPorCliente = {};
  if (colTramo) {
    for (const f of d.clienteTramo || []) {
      const c = f[colCli], t = etiquetaDe(f[colTramo]);
      if (c === undefined || t === null || typeof f.deudaCobranza !== "number") continue;
      (agingPorCliente[c] = agingPorCliente[c] || {})[t] = f.deudaCobranza;
    }
  }
  const conceptoPorCliente = {};
  if (colConc) {
    for (const f of d.clienteConcepto || []) {
      const c = f[colCli], x = etiquetaDe(f[colConc]);
      if (c === undefined || x === null || typeof f.deudaFacturacion !== "number") continue;
      if (!f.deudaFacturacion) continue;
      (conceptoPorCliente[c] = conceptoPorCliente[c] || []).push(
        { etiqueta: x, valor: f.deudaFacturacion });
    }
    for (const c of Object.keys(conceptoPorCliente)) {
      conceptoPorCliente[c].sort((a, b) => b.valor - a.valor);
      conceptoPorCliente[c] = conceptoPorCliente[c].slice(0, 8);
    }
  }

  /* Un cliente puede tener varias razones sociales y varios gestores dentro
     del aging: se pliegan a una fila, y si hay más de una razón social se dice
     cuántas en vez de elegir una al azar. La facturación llega por separado,
     ya agregada por cliente, y se une por nombre. */
  const porCliente = new Map();
  const dame = (nombre) => {
    let c = porCliente.get(nombre);
    if (!c) {
      c = { cliente: nombre, razones: new Set(), gestores: new Set(),
            cobranza: 0, facturacion: 0, vencida: 0, hay: {} };
      porCliente.set(nombre, c);
    }
    return c;
  };

  /* Hay documentos sin cliente asignado, y el tablero los muestra como una
     fila con su propio saldo (a veces negativo): son las cobranzas sin número
     de contrato, que es la clave de la relación con clientes. El tablero las
     rotula «(En blanco)». Descartarlas hacía que la tabla no sumara al total y
     nadie pudiera explicar la diferencia. */
  const SIN_CLIENTE = "(En blanco)";
  for (const f of d.clientesCobranza || []) {
    const nombre = etiquetaDe(f[colCli]) || SIN_CLIENTE;
    const c = dame(nombre);
    if (colRazon && etiquetaDe(f[colRazon])) c.razones.add(String(f[colRazon]).trim());
    if (colKam   && etiquetaDe(f[colKam]))   c.gestores.add(String(f[colKam]).trim());
    for (const [campo, clave] of [["cobranza", "deudaCobranza"], ["vencida", "deudaVencida"]]) {
      if (typeof f[clave] === "number") { c[campo] += f[clave]; c.hay[campo] = true; }
    }
  }
  for (const f of d.clientesFacturacion || []) {
    const nombre = etiquetaDe(f[colCli]) || SIN_CLIENTE;
    const c = dame(nombre);
    if (typeof f.deudaFacturacion === "number") {
      c.facturacion += f.deudaFacturacion; c.hay.facturacion = true;
    }
  }

  /* ── apertura mensual, por cliente ──────────────────────────────────
     Los años cerrados se agrupan enteros y el año en curso se abre mes por
     mes: es como lo muestra el tablero, y un año viejo en doce columnas no
     aporta nada. */
  const mesesPorCliente = {};
  if (Q.c("anioProvision") && Q.c("mesProvision")) {
    const colAnio = nombreCorto(Q.c("anioProvision"));
    const colMes  = nombreCorto(Q.c("mesProvision"));
    const anios = new Set();
    for (const f of d.clienteMes || []) {
      const a = Number(f[colAnio]);
      if (Number.isFinite(a) && a > 1990) anios.add(a);
    }
    const enCurso = anios.size ? Math.max(...anios) : null;
    for (const f of d.clienteMes || []) {
      const cli = etiquetaDe(f[colCli]) || SIN_CLIENTE;
      const a = Number(f[colAnio]), mes = Number(f[colMes]);
      const v = f.deudaFacturacion;
      if (typeof v !== "number" || !Number.isFinite(a)) continue;
      const casillas = mesesPorCliente[cli] || (mesesPorCliente[cli] = { anios: {}, meses: {} });
      if (a === enCurso && mes >= 1 && mes <= 12) {
        casillas.meses[mes] = (casillas.meses[mes] || 0) + v;
      } else {
        casillas.anios[a] = (casillas.anios[a] || 0) + v;
      }
    }
    for (const c of Object.values(mesesPorCliente)) c.enCurso = enCurso;
  }

  /* ── observaciones ─────────────────────────────────────────────────
     La hoja escribe el cliente a mano («VISTA OIL», «Vista OIL»), así que la
     unión es por nombre normalizado. La fecha viene dentro del texto, al
     final y a veces entre paréntesis: se extrae para mostrarla aparte. */
  const obsPorCliente = {};
  if (Q.c("obsCliente") && Q.c("obsTexto")) {
    const colOC = nombreCorto(Q.c("obsCliente"));
    const colOT = nombreCorto(Q.c("obsTexto"));
    for (const f of d.observaciones || []) {
      const quien = etiquetaDe(f[colOC]);
      const texto = etiquetaDe(f[colOT]);
      if (!quien || !texto) continue;
      (obsPorCliente[pelar(quien)] = obsPorCliente[pelar(quien)] || []).push(texto);
    }
  }
  const observacionDe = (cliente) => {
    const xs = obsPorCliente[pelar(cliente)];
    if (!xs || !xs.length) return undefined;
    const texto = xs.join(" · ");
    return { texto, fecha: fechaDeObservacion(texto) };
  };

  const clientes = [...porCliente.values()]
    .map((c) => {
      const razones = [...c.razones].filter((r) => r !== c.cliente);
      const gestores = [...c.gestores];
      const salida = {
        cliente: c.cliente,
        // Cuántas son de verdad, o la única que hay. Nunca un número que no
        // corresponda a este cliente.
        razon: razones.length === 1 ? razones[0]
             : razones.length > 1 ? razones.length + " razones sociales"
             : undefined,
        razones: razones.length > 1 ? razones.slice(0, 12) : undefined,
        gestor: gestores.length === 1 ? gestores[0]
              : gestores.length > 1 ? gestores.length + " gestores"
              : undefined,
        aging: agingPorCliente[c.cliente] ? ordenarTramos(
          Object.entries(agingPorCliente[c.cliente]).map(([e, v]) => ({ etiqueta: e, valor: v }))) : undefined,
        conceptos: conceptoPorCliente[c.cliente],
        meses: mesesPorCliente[c.cliente]
          ? aperturaMensual(mesesPorCliente[c.cliente]) : undefined,
        observacion: observacionDe(c.cliente)
      };
      for (const campo of ["cobranza", "facturacion", "vencida"]) {
        if (c.hay[campo]) salida[campo] = c[campo];
      }
      // La exposición es la suma de lo que este informe está mostrando.
      const t = (salida.cobranza || 0) + (salida.facturacion || 0);
      if (c.hay.cobranza || c.hay.facturacion) salida.total = t;
      salida.pctVencida = typeof salida.vencida === "number" && t
        ? (salida.vencida / t) * 100 : undefined;
      salida.pctFacturacion = typeof salida.facturacion === "number" && k.deudaFacturacion
        ? (salida.facturacion / k.deudaFacturacion) * 100 : undefined;
      return salida;
    })
    .filter((f) => [f.total, f.cobranza, f.facturacion].some((v) => typeof v === "number" && v !== 0))
    .map((f) => f.cliente === SIN_CLIENTE ? { ...f, sinCliente: true, razon: undefined } : f)
    // los sin cliente van al final: son saldos a identificar, no un cliente
    .sort((a, b) => (a.sinCliente ? 1 : 0) - (b.sinCliente ? 1 : 0) ||
                    (b.total || 0) - (a.total || 0));

  const conCobranza   = clientes.filter((c) => typeof c.cobranza === "number" && c.cobranza !== 0);
  const conFacturacion= clientes.filter((c) => typeof c.facturacion === "number" && c.facturacion !== 0);

  /* ── aperturas sueltas, para las solapas de detalle ──────────────── */
  const apertura = (filas, clave, medida, rotulo) => {
    const col = Q.c(clave);
    if (!col) return null;
    const items = ranking(filas, col, medida);
    return items.length ? { clave, rotulo, items } : null;
  };
  const aperturasCobranza = [
    apertura(d.claseDoc,  "claseDocumento",    "deudaCobranza", "Clase de documento"),
    apertura(d.tipoDeuda, "tipoDeuda",         "deudaCobranza", "Tipo de deuda"),
    apertura(d.estadoVto, "estadoVencimiento", "deudaCobranza", "Estado de vencimiento"),
    apertura(d.condPago,  "condicionPago",     "deudaCobranza", "Condición de pago"),
    apertura(d.gestor,    "clienteKam",        "deudaCobranza", "Gestor de cobranzas")
  ].filter(Boolean);
  const aperturasFacturacion = [
    apertura(d.concepto,  "concepto",         "deudaFacturacion", "Concepto"),
    apertura(d.tipoProv,  "tipoProvision",    "deudaFacturacion", "Tipo"),
    apertura(d.statusFac, "statusPendiente",  "deudaFacturacion", "Estado")
  ].filter(Boolean);

  const tarjetas = [
    typeof k.deudaTotal === "number" ? { valor: k.deudaTotal, etiqueta: "Exposición total",
      formato: "moneda", titular: true, nota: "Cobranza + facturación pendiente" } : null,
    kpi("deudaCobranza", k, { etiqueta: "Deuda de cobranza", formato: "moneda", sentido: "negativo",
      nota: "Saldo del aging, según sistema" }),
    kpi("deudaFacturacion", k, { etiqueta: "Pendiente de facturar", formato: "moneda", sentido: "negativo",
      nota: "Provisión todavía no facturada" }),
    kpi("deudaVencida", k, { etiqueta: "Deuda vencida", formato: "moneda",
      nota: vencidaPct === undefined ? undefined : unDecimal(vencidaPct) + " % de la cartera" }),
    typeof k.indiceRiesgo === "number" ? { valor: k.indiceRiesgo, etiqueta: "Índice de riesgo",
      formato: "pct", sentido: "negativo", nota: "Vencida sobre exposición total" } : null,
    kpi("clientesActivos", k, { etiqueta: "Clientes", formato: "entero" }),
    dsoValor === undefined ? null : { etiqueta: "Días en calle", valor: dsoValor,
      formato: "dias", nota: dsoPeriodo ? "Último período: " + dsoPeriodo : undefined,
      serie: serieDso.length > 2 ? serieDso.slice(-8).map((f) => f.dso) : undefined }
  ];

  return {
    secciones: hojas({ tarjetas, tramos, tramosFact, negocio, canal, clientes, colKam,
                       serieDso, colDso, k, vencidaPct, aperturasCobranza, aperturasFacturacion }),
    tablero: tablero({ tarjetas, tramos, tramosFact, negocio, canal, clientes,
                       conCobranza, conFacturacion, aperturasCobranza, aperturasFacturacion,
                       serieDso, colDso, dsoPorAnio, dsoValor, dsoPeriodo, k, vencidaPct, colKam })
  };
}

/* ══ salida 1 · las hojas A4 ═════════════════════════════════════════════ */

function hojas(x) {
  const { tarjetas, tramos, tramosFact, negocio, canal, clientes, colKam, serieDso,
          colDso, k, vencidaPct, aperturasCobranza, aperturasFacturacion } = x;

  const cima = clientes.slice(0, TOPE_IMPRESO);

  const columnas = [
    { clave: "cliente", titulo: "Cliente", tipo: "texto" },
    colKam ? { clave: "gestor", titulo: "Gestor", tipo: "texto" } : null,
    { clave: "total", titulo: "Exposición", tipo: "monto" },
    Q.m("deudaCobranza") && { clave: "cobranza", titulo: "Cobranza", tipo: "monto" },
    Q.m("deudaFacturacion") && { clave: "facturacion", titulo: "Facturación", tipo: "monto" },
    Q.m("deudaVencida") && { clave: "vencida", titulo: "Vencida", tipo: "monto" },
    Q.m("deudaVencida") && { clave: "pctVencida", titulo: "% vencido", tipo: "pct" }
  ].filter(Boolean);

  // El detalle de «ver datos»: NO los mismos números del gráfico, sino la
  // apertura que hay detrás. Un gráfico de aging muestra, abajo, quién compone
  // cada tramo; uno de concepto, qué cliente lo trae.
  const detalleClientes = (campo, titulo) => {
    const filas = clientes
      .filter((c) => typeof c[campo] === "number" && c[campo] !== 0)
      .sort((a, b) => b[campo] - a[campo])
      .slice(0, TOPE_IMPRESO)
      .map((c) => ({ cliente: c.cliente, razon: c.razon, valor: c[campo] }));
    return filas.length ? {
      titulo,
      columnas: [{ clave: "cliente", titulo: "Cliente", tipo: "texto" },
                 { clave: "razon", titulo: "Razón social", tipo: "texto" },
                 { clave: "valor", titulo: "Monto", tipo: "monto" }],
      filas
    } : undefined;
  };

  // También acotadas: una hoja con cincuenta renglones de apertura no se lee.
  const detalleApertura = (lista, titulo) => {
    const filas = [];
    for (const a of lista) {
      const top = a.items.filter((it) => it.valor)
        .sort((x, y) => Math.abs(y.valor) - Math.abs(x.valor))
        .slice(0, TOPE_IMPRESO);
      for (const it of top) filas.push({ dimension: a.rotulo, valor: it.etiqueta, monto: it.valor });
    }
    return filas.length ? {
      titulo,
      columnas: [{ clave: "dimension", titulo: "Apertura", tipo: "texto" },
                 { clave: "valor", titulo: "Valor", tipo: "texto" },
                 { clave: "monto", titulo: "Monto", tipo: "monto" }],
      filas
    } : undefined;
  };

  return limpiar([
    { tipo: "kpis", items: tarjetas },

    tramos.length ? { tipo: "barrasHorizontales",
      titulo: "Cobranza por tramo de vencimiento",
      subtitulo: "Cartera completa, sin corte de período",
      medida: refs(["deudaCobranza"]), formato: "moneda", ejeEtiqueta: "Tramo",
      items: tramos,
      detalle: detalleApertura(aperturasCobranza, "Cobranza abierta por otras dimensiones"),
      nota: "El aging es una foto al momento de la última actualización del modelo." } : null,

    tramosFact.length ? { tipo: "barrasHorizontales",
      titulo: "Pendiente de facturar por antigüedad",
      subtitulo: "Provisión no facturada, acumulada",
      medida: refs(["deudaFacturacion"]), formato: "moneda", ejeEtiqueta: "Tramo",
      items: tramosFact,
      detalle: detalleApertura(aperturasFacturacion, "Facturación abierta por concepto y estado") } : null,

    negocio.length ? { tipo: "barrasHorizontales", titulo: "Exposición por negocio",
      medida: refs(["deudaCobranza", "deudaFacturacion"]), formato: "moneda", ejeEtiqueta: "Negocio",
      items: negocio,
      detalle: detalleClientes("total", "Exposición por cliente") } : null,

    canal.length ? { tipo: "barrasHorizontales", titulo: "Cobranza por canal",
      medida: refs(["deudaCobranza"]), formato: "moneda", ejeEtiqueta: "Canal",
      items: canal } : null,

    serieDso.length > 2 ? { tipo: "lineas", titulo: "Días en calle",
      subtitulo: "Días de venta pendientes de cobro", medida: refs(["dso"]),
      formato: "dias", formatoEje: "entero", ejeEtiqueta: "Período",
      ejeX: serieDso.map((f) => etiquetaMes(f[colDso])),
      series: [{ nombre: "Días en calle", datos: serieDso.map((f) => f.dso) }] } : null,

    clientes.length ? { tipo: "saltoPagina" } : null,

    clientes.length ? { tipo: "barrasHorizontales",
      titulo: "Concentración por cliente",
      subtitulo: "Los " + Math.min(TOPE_IMPRESO, clientes.length) + " de mayor exposición",
      medida: refs(["deudaCobranza", "deudaFacturacion"]), formato: "moneda", ejeEtiqueta: "Cliente",
      items: cima.map((f) => ({ etiqueta: f.cliente, valor: f.total })),
      detalle: detalleClientes("facturacion", "Pendiente de facturar por cliente") } : null,

    // El impreso muestra el top, no la cartera entera: una hoja con cuarenta
    // filas no se lee, y el tablero tiene la tabla completa con buscador.
    cima.length ? { tipo: "tabla", titulo: "Detalle por cliente",
      subtitulo: "Top " + cima.length + " por exposición" +
        (clientes.length > cima.length ? " · " + clientes.length + " en total" : ""),
      medida: refs(["deudaCobranza", "deudaFacturacion"]), columnas,
      filas: cima.map((c) => ({
        cliente: c.cliente, gestor: c.gestor, total: c.total, cobranza: c.cobranza,
        facturacion: c.facturacion, vencida: c.vencida, pctVencida: c.pctVencida })),
      total: { cliente: "Total cartera", gestor: "", total: k.deudaTotal,
        cobranza: k.deudaCobranza, facturacion: k.deudaFacturacion,
        vencida: k.deudaVencida, pctVencida: vencidaPct },
      nota: clientes.length > cima.length
        ? "El total es de la cartera completa (" + clientes.length + " clientes); la tabla " +
          "lista los " + cima.length + " de mayor exposición."
        : "Ordenado por exposición total." } : null
  ]);
}

/* ══ salida 2 · el tablero interactivo ═══════════════════════════════════ */

function tablero(x) {
  const { tarjetas, tramos, tramosFact, negocio, canal, clientes, conCobranza,
          conFacturacion, aperturasCobranza, aperturasFacturacion, serieDso, colDso,
          dsoPorAnio, dsoValor, dsoPeriodo, k, vencidaPct, colKam } = x;

  const colsCliente = (campos) => [
    { clave: "cliente", titulo: "Cliente", tipo: "cliente", sub: "razon" },
    colKam ? { clave: "gestor", titulo: "Gestor", tipo: "texto" } : null,
    ...campos
  ].filter(Boolean);

  const solapas = [];

  /* ── Resumen ─────────────────────────────────────────────────────── */
  solapas.push({ clave: "resumen", rotulo: "Resumen", bloques: limpiar([
    { tipo: "kpis", items: tarjetas },
    // severidad: el color del tramo es parte del dato, como en el tablero
    tramos.length ? { tipo: "aging", titulo: "Aging — Deuda de cobranza",
      subtitulo: "Saldo del aging por tramo de vencimiento",
      items: tramos, formato: "moneda", severidad: true } : null,
    tramosFact.length ? { tipo: "aging", titulo: "Aging — Pendiente de facturar",
      subtitulo: "Antigüedad de la provisión no facturada",
      items: tramosFact, formato: "moneda", severidad: true } : null,
    negocio.length ? { tipo: "aging", titulo: "Exposición por negocio",
      items: negocio, formato: "moneda" } : null,
    prioridad(clientes)
  ])});

  /* ── Cobranza ────────────────────────────────────────────────────── */
  if (conCobranza.length) {
    solapas.push({ clave: "cobranza", rotulo: "Cobranza", bloques: limpiar([
      { tipo: "tablaViva", titulo: "Deuda por cobrar",
        subtitulo: conCobranza.length + " clientes con saldo en gestión de Cobranzas",
        buscar: "Buscar cliente…", buscarEn: ["cliente", "razon", "gestor"],
        orden: { clave: "cobranza", desc: true },
        filtros: [
          Q.m("deudaVencida")
            ? { clave: "vencido", rotulo: "Solo con saldo vencido", campo: "vencida", op: ">", valor: 0 }
            : null
        ].filter(Boolean),
        columnas: colsCliente([
          tramos.length ? { clave: "aging", titulo: "Aging", tipo: "aging" } : null,
          { clave: "cobranza", titulo: "Deuda de cobranza", tipo: "monto" },
          Q.m("deudaVencida") ? { clave: "vencida", titulo: "Vencida", tipo: "monto" } : null,
          Q.m("deudaVencida") ? { clave: "pctVencida", titulo: "% vencido", tipo: "pct" } : null
        ].filter(Boolean)),
        filas: conCobranza,
        total: { cliente: "Total", cobranza: k.deudaCobranza, vencida: k.deudaVencida,
                 pctVencida: vencidaPct } },
      ...aperturasCobranza.map((a) => ({ tipo: "aging", titulo: "Cobranza por " + a.rotulo.toLowerCase(),
        items: a.items, formato: "moneda", plegable: true }))
    ])});
  }

  /* ── Facturación ─────────────────────────────────────────────────── */
  if (clientes.length && Q.m("deudaFacturacion")) {
    solapas.push({ clave: "facturacion", rotulo: "Facturación", bloques: limpiar([
      { tipo: "tablaViva", titulo: "Pendiente de facturar",
        subtitulo: conFacturacion.length + " de " + clientes.length +
          " clientes tienen trabajo no facturado",
        buscar: "Buscar cliente…", buscarEn: ["cliente", "razon"],
        orden: { clave: "facturacion", desc: true },
        // Se listan TODOS los clientes de la cartera: que uno no tenga nada
        // pendiente también es información, y esconderlo obliga a buscarlo en
        // otra solapa para confirmarlo.
        filtros: [{ clave: "conPendiente", rotulo: "Solo con pendiente",
                    campo: "facturacion", op: ">", valor: 0 }],
        // Las columnas del tablero: el pendiente, su peso en la cartera, la
        // apertura mensual que se abre con «+» y la observación de gestión.
        columnas: colsCliente([
          { clave: "facturacion", titulo: "Pendiente de facturar", tipo: "monto" },
          { clave: "pctFacturacion", titulo: "% del total", tipo: "pct" },
          clientes.some((c) => c.conceptos)
            ? { clave: "conceptos", titulo: "Conceptos", tipo: "chips" } : null,
          clientes.some((c) => c.observacion)
            ? { clave: "observacion", titulo: "Observación", tipo: "observacion" } : null
        ].filter(Boolean)),
        // la apertura que se despliega por fila
        expandir: clientes.some((c) => c.meses) ? "meses" : undefined,
        filas: clientes,
        total: { cliente: "Total", facturacion: k.deudaFacturacion, pctFacturacion: 100 } },
      ...aperturasFacturacion.map((a) => ({ tipo: "aging", titulo: "Facturación por " + a.rotulo.toLowerCase(),
        items: a.items, formato: "moneda", plegable: true }))
    ])});
  }

  /* ── Cliente 360° ────────────────────────────────────────────────── */
  if (clientes.length) {
    solapas.push({ clave: "cliente360", rotulo: "Cliente 360°", bloques: limpiar([
      { tipo: "ranking", titulo: "Ranking por exposición total",
        subtitulo: "Cobranza + pendiente de facturar, de mayor a menor",
        items: clientes.slice(0, 20)
          .filter((c) => typeof c.total === "number")
          .map((c) => ({ etiqueta: c.cliente, valor: c.total })), formato: "moneda" },
      { tipo: "tablaViva", titulo: "Exposición combinada",
        subtitulo: clientes.length + " clientes",
        buscar: "Buscar cliente…", buscarEn: ["cliente", "razon", "gestor"],
        orden: { clave: "total", desc: true },
        columnas: colsCliente([
          { clave: "cobranza", titulo: "Cobranza", tipo: "monto" },
          { clave: "facturacion", titulo: "Facturación", tipo: "monto" },
          { clave: "vencida", titulo: "Vencida", tipo: "monto" },
          { clave: "total", titulo: "Exposición", tipo: "monto" }
        ]),
        filas: clientes,
        total: { cliente: "Total", cobranza: k.deudaCobranza, facturacion: k.deudaFacturacion,
                 vencida: k.deudaVencida, total: k.deudaTotal } }
    ])});
  }

  /* ── Días en calle ───────────────────────────────────────────────── */
  if (serieDso.length > 2) {
    const valores = serieDso.map((f) => f.dso);
    const anios = Object.keys(dsoPorAnio).sort();
    const ultimo = anios[anios.length - 1];
    solapas.push({ clave: "diasEnCalle", rotulo: "Días en calle", bloques: limpiar([
      { tipo: "kpis", items: [
        { etiqueta: "Último período" + (dsoPeriodo ? " (" + dsoPeriodo + ")" : ""),
          valor: dsoValor, formato: "dias", titular: true,
          nota: dsoValor === Math.min(...valores) ? "Mínimo de toda la serie" : undefined },
        ultimo ? { etiqueta: "Promedio " + ultimo, valor: dsoPorAnio[ultimo], formato: "dias" } : null,
        { etiqueta: "Promedio histórico", valor: promedio(valores), formato: "dias",
          nota: serieDso.length + " meses" }
      ].filter(Boolean) },
      { tipo: "lineas", titulo: "Evolución mensual",
        subtitulo: "Días de venta pendientes de cobro", medida: refs(["dso"]),
        formato: "dias", formatoEje: "entero", ejeEtiqueta: "Período",
        ejeX: serieDso.map((f) => etiquetaMes(f[colDso])),
        series: [{ nombre: "Días en calle", datos: valores }] },
      anios.length > 1 ? { tipo: "tablaViva", titulo: "Promedio por año",
        columnas: [{ clave: "anio", titulo: "Año", tipo: "texto" },
                   { clave: "promedio", titulo: "Promedio", tipo: "dias" }],
        filas: anios.map((a) => ({ anio: a, promedio: dsoPorAnio[a] })) } : null
    ])});
  }

  /* ── Notas y alcance ─────────────────────────────────────────────── */
  solapas.push({ clave: "notas", rotulo: "Notas y alcance",
    bloques: [{ tipo: "notas", titulo: "Notas y alcance de los datos",
      subtitulo: "Para tener en cuenta al leer el tablero",
      items: notas({ tramos, tramosFact, clientes, k }) }] });

  return {
    titulo: "Tablero de Deuda",
    bajada: "Cobranza y facturación pendiente, por cliente",
    solapas
  };
}

/** Los clientes que más pesan en lo vencido: la lista con la que se trabaja. */
function prioridad(clientes) {
  if (!Q.m("deudaVencida")) return null;
  const items = clientes
    .filter((c) => typeof c.vencida === "number" && c.vencida > 0)
    .sort((a, b) => b.vencida - a.vencida)
    .slice(0, 8)
    .map((c) => ({ etiqueta: c.cliente, valor: c.vencida,
                   nota: c.pctVencida === undefined ? undefined
                     : unDecimal(c.pctVencida) + " % de su exposición" }));
  return items.length ? { tipo: "ranking", titulo: "Prioridad de seguimiento",
    subtitulo: "Clientes con mayor saldo vencido", items, formato: "moneda" } : null;
}

/**
 * Las notas se escriben desde lo que los datos dicen, no desde un texto fijo:
 * lo que hace útil esta solapa es que discuta ESTE modelo.
 */
function notas({ tramos, tramosFact, clientes, k }) {
  const n = [];
  const ex = MODELO.leer().exclusiones || [];
  if (ex.length) {
    n.push({ titulo: "Este informe replica las exclusiones del tablero",
      cuerpo: "No mira el modelo entero: " +
              ex.map((r) => Q.textoExclusion(r, r.campo)).join(" · ") + ". " +
              "Son las mismas reglas que declara el tablero en Power BI, y por eso los " +
              "totales coinciden con esa pantalla y no con el modelo completo." });
  }
  if (clientes.some((c) => c.sinCliente)) {
    n.push({ titulo: "Hay saldo sin cliente asignado",
      cuerpo: "Las cobranzas sin número de contrato no se pueden atar a un cliente, porque " +
              "ese número es la clave de la relación. Se listan como «(En blanco)» al final " +
              "de la tabla, con su saldo —que puede ser negativo—, igual que en el tablero: " +
              "así la suma de la tabla cierra con el total." });
  }
  n.push({ titulo: "La cartera es una foto, no un acumulado",
    cuerpo: "Los totales y el aging no llevan filtro de período: muestran el saldo " +
            "al momento de la última actualización del modelo. Filtrar por mes daría " +
            "las facturas que vencen en ese mes, que es otra cosa." });
  if (Q.m("deudaCobranza") && Q.m("deudaFacturacion")) {
    n.push({ titulo: "Cobranza y Facturación son dos universos",
      cuerpo: "Cobranza (" + Q.m("deudaCobranza") + ") es el saldo del aging, tal como " +
              "está en el sistema. Facturación (" + Q.m("deudaFacturacion") + ") es la " +
              "provisión todavía no facturada. Sólo se suman en la exposición combinada; " +
              "un cliente puede aparecer en una y no en la otra." });
  }
  if (Q.m("deudaVencida")) {
    n.push({ titulo: "Qué cuenta como vencido",
      cuerpo: "La medida " + Q.m("deudaVencida") + " define el corte de vencimiento en el " +
              "modelo, no este informe. Si el tablero excluye algún tramo del vencido, acá " +
              "se respeta esa definición." });
  }
  if (Q.m("indiceRiesgo")) {
    n.push({ titulo: "El índice de riesgo viene en porcentaje",
      cuerpo: "El modelo devuelve " + Q.m("indiceRiesgo") + " ya multiplicado por 100 " +
              "(vencida sobre exposición total), así que se muestra tal cual." });
  }
  if (clientes.length >= TOPE_CONSULTA) {
    n.push({ titulo: "La cartera se acota en " + TOPE_CONSULTA + " clientes",
      cuerpo: "La consulta trae los " + TOPE_CONSULTA + " de mayor exposición. Los totales " +
              "de las tarjetas son de la cartera completa, así que la suma de la tabla puede " +
              "quedar por debajo." });
  }
  n.push({ titulo: "El informe impreso muestra el top " + TOPE_IMPRESO,
    cuerpo: "Las tablas y aperturas de las hojas se acotan a los " + TOPE_IMPRESO +
            " clientes de mayor exposición, que es lo que se lee en una hoja. Los totales " +
            "siguen siendo de la cartera completa, y el tablero tiene la tabla entera con buscador." });
  if (tramos.length && tramosFact.length) {
    n.push({ titulo: "Hay dos aging porque son dos cosas distintas",
      cuerpo: "El aging de cobranzas mide " + Q.m("deudaCobranza") + " sobre " +
              Q.c("agingTramo") + ": antigüedad de lo ya facturado y no cobrado. El de " +
              "facturación mide " + Q.m("deudaFacturacion") + " sobre " + Q.c("tramoFacturacion") +
              ", que vive en la provisión: antigüedad de lo trabajado y todavía no facturado. " +
              "Son medidas y tramos independientes; cada gráfico usa el suyo y no se suman entre sí." });
  }
  return n.map((x, i) => ({ n: String(i + 1).padStart(2, "0"), ...x }));
}

/* ══ utilidades ══════════════════════════════════════════════════════════ */

const MES_AB = ["Ene", "Feb", "Mar", "Abr", "May", "Jun",
                "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

/** Los años cerrados primero, después los meses del año en curso. */
function aperturaMensual({ anios, meses, enCurso }) {
  const celdas = [];
  for (const a of Object.keys(anios).map(Number).sort((x, y) => x - y)) {
    celdas.push({ etiqueta: String(a), valor: anios[a], anio: true });
  }
  for (let m = 1; m <= 12; m++) {
    if (!(m in meses)) continue;
    celdas.push({ etiqueta: MES_AB[m - 1], valor: meses[m], mes: m });
  }
  return celdas.length ? { celdas, enCurso } : undefined;
}

/** Sin tildes ni puntuación: «VISTA OIL» y «Vista OIL» son el mismo cliente. */
const pelar = (x) => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * La fecha de gestión viene pegada al final del texto, con o sin paréntesis:
 * «… todo solicitado (1/9)» o «… entran en Ago26. 8/9». Se extrae para
 * mostrarla como marca aparte, que es lo que hace útil la columna.
 */
function fechaDeObservacion(texto) {
  const m = String(texto).match(/\(?\b(\d{1,2})\s*\/\s*(\d{1,2})\b\)?\s*$/);
  if (!m) return undefined;
  const dia = Number(m[1]), mes = Number(m[2]);
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return undefined;
  return dia + "/" + mes;
}

/** Un valor de dimensión legible, o null si no lo es. */
function etiquetaDe(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Junta varias listas {etiqueta, valor} sumando por etiqueta. */
function sumarPorEtiqueta(listas) {
  const m = new Map();
  for (const lista of listas) for (const x of lista || []) {
    m.set(x.etiqueta, (m.get(x.etiqueta) || 0) + x.valor);
  }
  return [...m.entries()].map(([etiqueta, valor]) => ({ etiqueta, valor }));
}

const promedio = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
const unDecimal = (v) => new Intl.NumberFormat("es-AR",
  { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);

/** Promedio de la serie de DSO por año, leyendo el año del período. */
function promediosPorAnio(serie, col) {
  const porAnio = {};
  for (const f of serie) {
    const a = String(f[col]).match(/^(\d{4})/);
    if (!a) continue;
    (porAnio[a[1]] = porAnio[a[1]] || []).push(f.dso);
  }
  const salida = {};
  for (const [a, xs] of Object.entries(porAnio)) salida[a] = promedio(xs);
  return salida;
}

/** «0-30» antes que «31-60» antes que «+90», con «A vencer» primero. */
function ordenarTramos(items) {
  const peso = (e) => {
    const s = String(e).toLowerCase();
    if (/no vencid|a vencer|por vencer|corriente|sin vencim/.test(s)) return -1;
    const n = s.match(/\d+/);
    return n ? Number(n[0]) : 9999;
  };
  return items.slice().sort((a, b) => peso(a.etiqueta) - peso(b.etiqueta));
}

const requiere = { medidas: ["deudaCobranza", "deudaFacturacion"], columnas: [] };

module.exports = { meta, consultas, construir, requiere };
