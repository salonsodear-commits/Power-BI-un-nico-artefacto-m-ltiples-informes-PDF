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
const Q = require("../powerbi/queries");
const { limpiar, kpi, etiquetaMes } = require("./comun");
const { nombreCorto, refs } = require("./ejecutivo");

const meta = {
  nombre: "Deuda",
  titulo: "Informe de Deuda y Cobranzas",
  bajada: "Cartera por tramo de vencimiento, concentración por cliente y exposición al riesgo.",
  fuente: "Power BI — Deuda"
};

const MEDIDAS_KPI = ["deudaTotal", "deudaCobranza", "deudaFacturacion", "deudaVencida",
                     "indiceRiesgo", "clientesActivos", "importeFacturado"];
const MEDIDAS_CLIENTE = ["deudaTotal", "deudaCobranza", "deudaFacturacion", "deudaVencida"];
const TOPE_CLIENTES = 40;

/** Los cortes que el usuario haya pedido, si están mapeados. */
const cortes = (p) => Q.fDimensiones(p);

/* ══ consultas ═══════════════════════════════════════════════════════════
   Cada una es opcional: si el modelo no tiene la columna, `desglose`
   devuelve null y la vista correspondiente no se arma. */
function consultas(p) {
  const q = {};
  const f = cortes(p);
  const dims = f.map((x) => "    " + x);

  const fila = Q.filaMedidas(MEDIDAS_KPI);
  if (fila) {
    q.kpis = dims.length
      ? `\nEVALUATE\n  CALCULATETABLE(\n    ROW(\n${fila}\n    ),\n${dims.join(",\n")}\n  )`
      : `\nEVALUATE\n  ROW(\n${fila}\n  )`;
  }

  // ── aging: el de cobranza y el de facturación son columnas distintas ──
  q.tramos = Q.desglose({ por: Q.c("agingTramo"), filtros: f,
    medidas: ["deudaCobranza", "deudaVencida"] });
  q.tramosFact = Q.desglose({ por: Q.c("tramoFacturacion"), filtros: f,
    medidas: ["deudaFacturacion"] });

  // ── cortes de cartera ────────────────────────────────────────────────
  q.negocio = Q.desglose({ por: Q.c("vertical"), filtros: f, medidas: ["deudaTotal", "deudaCobranza", "deudaFacturacion"] });
  q.canal   = Q.desglose({ por: Q.c("canal"),    filtros: f, medidas: ["deudaTotal"] });
  q.gestor  = Q.desglose({ por: Q.c("clienteKam"), filtros: f, medidas: ["deudaCobranza", "deudaVencida"] });

  // ── aperturas del detalle: lo que «ver datos» tiene para mostrar ─────
  q.claseDoc  = Q.desglose({ por: Q.c("claseDocumento"),   filtros: f, medidas: ["deudaCobranza"] });
  q.tipoDeuda = Q.desglose({ por: Q.c("tipoDeuda"),        filtros: f, medidas: ["deudaCobranza"] });
  q.estadoVto = Q.desglose({ por: Q.c("estadoVencimiento"),filtros: f, medidas: ["deudaCobranza"] });
  q.condPago  = Q.desglose({ por: Q.c("condicionPago"),    filtros: f, medidas: ["deudaCobranza"] });
  q.concepto  = Q.desglose({ por: Q.c("concepto"),         filtros: f, medidas: ["deudaFacturacion", "importeFacturado"], tope: 40 });
  q.tipoProv  = Q.desglose({ por: Q.c("tipoProvision"),    filtros: f, medidas: ["deudaFacturacion"] });
  q.statusFac = Q.desglose({ por: Q.c("statusPendiente"),  filtros: f, medidas: ["deudaFacturacion"] });

  // ── por cliente: la tabla viva de las solapas Cobranza y Cliente 360° ─
  const dimsCliente = [Q.c("clienteNombre"), Q.c("clienteRazon"), Q.c("clienteKam")].filter(Boolean);
  q.clientes = Q.desglose({ por: dimsCliente, filtros: f,
    medidas: MEDIDAS_CLIENTE, tope: TOPE_CLIENTES });
  // el aging de cada cliente, para la barrita de la tabla
  q.clienteTramo = Q.desglose({ por: [Q.c("clienteNombre"), Q.c("agingTramo")], filtros: f,
    medidas: ["deudaCobranza"] });
  // lo pendiente de facturar, abierto por cliente y concepto
  q.clienteConcepto = Q.desglose({ por: [Q.c("clienteNombre"), Q.c("concepto")], filtros: f,
    medidas: ["deudaFacturacion"], tope: 120 });

  // ── DSO: suele vivir en su propia tabla, sin relación con el calendario ─
  if (Q.m("dso") && Q.c("dsoPeriodo")) {
    q.dso = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("dsoPeriodo")},\n` +
      `    "dso", ${Q.m("dso")}\n  )\n  ORDER BY ${Q.c("dsoPeriodo")}`;
  } else if (Q.m("dso")) {
    q.dsoSuelto = `\nEVALUATE\n  ROW("dso", ${Q.m("dso")})`;
  }

  for (const k of Object.keys(q)) if (!q[k]) delete q[k];
  return q;
}

/* ══ armado ══════════════════════════════════════════════════════════════ */

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = (d.kpis || [])[0] || {};

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
  const ranking = (filas, col, valor) => (filas || [])
    .map((f) => ({ etiqueta: etiquetaDe(f[nombreCorto(col)]), valor: f[valor] }))
    .filter((x) => x.etiqueta !== null && typeof x.valor === "number" && x.valor !== 0);

  const tramos     = ordenarTramos(ranking(d.tramos, Q.c("agingTramo"), "deudaCobranza"));
  const tramosFact = Q.c("tramoFacturacion")
    ? ordenarTramos(ranking(d.tramosFact, Q.c("tramoFacturacion"), "deudaFacturacion")) : [];
  const negocio = ranking(d.negocio, Q.c("vertical"), "deudaTotal");
  const canal   = ranking(d.canal,   Q.c("canal"),    "deudaTotal");

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

  // Un cliente puede tener varias razones sociales y varios gestores: el
  // SUMMARIZECOLUMNS devuelve una fila por combinación. Se pliegan a una fila
  // por cliente, como hace el tablero, y si hay más de una razón social se
  // dice cuántas en vez de elegir una al azar.
  const porCliente = new Map();
  for (const f of d.clientes || []) {
    if (f[colCli] === undefined || f[colCli] === null) continue;
    const nombre = String(f[colCli]);
    let c = porCliente.get(nombre);
    if (!c) {
      c = { cliente: nombre, razones: new Set(), gestores: new Set(),
            total: 0, cobranza: 0, facturacion: 0, vencida: 0, hay: {} };
      porCliente.set(nombre, c);
    }
    if (colRazon && etiquetaDe(f[colRazon])) c.razones.add(String(f[colRazon]).trim());
    if (colKam   && etiquetaDe(f[colKam]))   c.gestores.add(String(f[colKam]).trim());
    for (const [campo, clave] of [["total", "deudaTotal"], ["cobranza", "deudaCobranza"],
                                  ["facturacion", "deudaFacturacion"], ["vencida", "deudaVencida"]]) {
      if (typeof f[clave] === "number") { c[campo] += f[clave]; c.hay[campo] = true; }
    }
  }

  const clientes = [...porCliente.values()]
    .map((c) => {
      const razones = [...c.razones].filter((r) => r !== c.cliente);
      const gestores = [...c.gestores];
      const salida = {
        cliente: c.cliente,
        razon: razones.length === 1 ? razones[0]
             : razones.length > 1 ? razones.length + " cuentas / razones sociales"
             : undefined,
        gestor: gestores.length === 1 ? gestores[0]
              : gestores.length > 1 ? gestores.length + " gestores"
              : undefined,
        aging: agingPorCliente[c.cliente] ? ordenarTramos(
          Object.entries(agingPorCliente[c.cliente]).map(([e, v]) => ({ etiqueta: e, valor: v }))) : undefined,
        conceptos: conceptoPorCliente[c.cliente]
      };
      // sólo los campos que alguna fila realmente trajo: 0 y «no vino» no son lo mismo
      for (const campo of ["total", "cobranza", "facturacion", "vencida"]) {
        if (c.hay[campo]) salida[campo] = c[campo];
      }
      salida.pctVencida = typeof salida.vencida === "number" && salida.total
        ? (salida.vencida / salida.total) * 100 : undefined;
      return salida;
    })
    .filter((f) => [f.total, f.cobranza, f.facturacion].some((v) => typeof v === "number" && v !== 0))
    .sort((a, b) => (b.total || b.cobranza || 0) - (a.total || a.cobranza || 0));

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
    kpi("deudaTotal", k, { etiqueta: "Exposición total", formato: "moneda", titular: true,
      nota: "Cobranza + facturación pendiente" }),
    kpi("deudaCobranza", k, { etiqueta: "Deuda de cobranza", formato: "moneda", sentido: "negativo",
      nota: "Saldo del aging, según sistema" }),
    kpi("deudaFacturacion", k, { etiqueta: "Pendiente de facturar", formato: "moneda", sentido: "negativo",
      nota: "Provisión todavía no facturada" }),
    kpi("deudaVencida", k, { etiqueta: "Deuda vencida", formato: "moneda",
      nota: vencidaPct === undefined ? undefined : unDecimal(vencidaPct) + " % de la cartera" }),
    kpi("indiceRiesgo", k, { etiqueta: "Índice de riesgo", formato: "pct", sentido: "negativo",
      nota: "Vencida sobre exposición total" }),
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

  const columnas = [
    { clave: "cliente", titulo: "Cliente", tipo: "texto" },
    colKam ? { clave: "gestor", titulo: "Gestor", tipo: "texto" } : null,
    Q.m("deudaTotal") && { clave: "total", titulo: "Exposición", tipo: "monto" },
    Q.m("deudaCobranza") && { clave: "cobranza", titulo: "Cobranza", tipo: "monto" },
    Q.m("deudaFacturacion") && { clave: "facturacion", titulo: "Facturación", tipo: "monto" },
    Q.m("deudaVencida") && { clave: "vencida", titulo: "Vencida", tipo: "monto" },
    Q.m("deudaVencida") && Q.m("deudaTotal") && { clave: "pctVencida", titulo: "% vencido", tipo: "pct" }
  ].filter(Boolean);

  // El detalle de «ver datos»: NO los mismos números del gráfico, sino la
  // apertura que hay detrás. Un gráfico de aging muestra, abajo, quién compone
  // cada tramo; uno de concepto, qué cliente lo trae.
  const detalleClientes = (campo, titulo) => {
    const filas = clientes
      .filter((c) => typeof c[campo] === "number" && c[campo] !== 0)
      .map((c) => ({ cliente: c.cliente, razon: c.razon, valor: c[campo] }));
    return filas.length ? {
      titulo,
      columnas: [{ clave: "cliente", titulo: "Cliente", tipo: "texto" },
                 { clave: "razon", titulo: "Razón social", tipo: "texto" },
                 { clave: "valor", titulo: "Monto", tipo: "monto" }],
      filas
    } : undefined;
  };

  const detalleApertura = (lista, titulo) => {
    const filas = [];
    for (const a of lista) {
      for (const it of a.items) {
        if (!it.valor) continue;
        filas.push({ dimension: a.rotulo, valor: it.etiqueta, monto: it.valor });
      }
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
      medida: refs(["deudaTotal"]), formato: "moneda", ejeEtiqueta: "Negocio",
      items: negocio,
      detalle: detalleClientes("total", "Exposición por cliente") } : null,

    canal.length ? { tipo: "barrasHorizontales", titulo: "Exposición por canal",
      medida: refs(["deudaTotal"]), formato: "moneda", ejeEtiqueta: "Canal",
      items: canal } : null,

    serieDso.length > 2 ? { tipo: "lineas", titulo: "Días en calle",
      subtitulo: "Días de venta pendientes de cobro", medida: refs(["dso"]),
      formato: "dias", formatoEje: "entero", ejeEtiqueta: "Período",
      ejeX: serieDso.map((f) => etiquetaMes(f[colDso])),
      series: [{ nombre: "Días en calle", datos: serieDso.map((f) => f.dso) }] } : null,

    clientes.length ? { tipo: "saltoPagina" } : null,

    clientes.length && Q.m("deudaTotal") ? { tipo: "barrasHorizontales",
      titulo: "Concentración por cliente", subtitulo: "Los de mayor exposición",
      medida: refs(["deudaTotal"]), formato: "moneda", ejeEtiqueta: "Cliente",
      items: clientes.slice(0, 12).map((f) => ({ etiqueta: f.cliente, valor: f.total })),
      detalle: detalleClientes("facturacion", "Pendiente de facturar por cliente") } : null,

    clientes.length ? { tipo: "tabla", titulo: "Detalle por cliente",
      medida: refs(["deudaTotal", "deudaVencida"]), columnas,
      filas: clientes.map((c) => ({
        cliente: c.cliente, gestor: c.gestor, total: c.total, cobranza: c.cobranza,
        facturacion: c.facturacion, vencida: c.vencida, pctVencida: c.pctVencida })),
      total: { cliente: "Total cartera", gestor: "", total: k.deudaTotal,
        cobranza: k.deudaCobranza, facturacion: k.deudaFacturacion,
        vencida: k.deudaVencida, pctVencida: vencidaPct },
      nota: "Ordenado por exposición total. La consulta trae los " + TOPE_CLIENTES + " primeros." } : null
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
    tramos.length ? { tipo: "aging", titulo: "Aging — Deuda de cobranza",
      subtitulo: "Saldo del aging por tramo de vencimiento",
      items: tramos, formato: "moneda" } : null,
    tramosFact.length ? { tipo: "aging", titulo: "Aging — Pendiente de facturar",
      subtitulo: "Antigüedad de la provisión no facturada",
      items: tramosFact, formato: "moneda" } : null,
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
  if (conFacturacion.length) {
    solapas.push({ clave: "facturacion", rotulo: "Facturación", bloques: limpiar([
      { tipo: "tablaViva", titulo: "Pendiente de facturar",
        subtitulo: conFacturacion.length + " clientes con trabajo no facturado",
        buscar: "Buscar cliente…", buscarEn: ["cliente", "razon"],
        orden: { clave: "facturacion", desc: true },
        columnas: colsCliente([
          { clave: "facturacion", titulo: "Pendiente de facturar", tipo: "monto" },
          { clave: "conceptos", titulo: "Principales conceptos", tipo: "chips" }
        ]),
        filas: conFacturacion,
        total: { cliente: "Total", facturacion: k.deudaFacturacion } },
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
  if (clientes.length >= TOPE_CLIENTES) {
    n.push({ titulo: "La tabla trae los " + TOPE_CLIENTES + " primeros",
      cuerpo: "La consulta acota por volumen. Los totales de las tarjetas son de la " +
              "cartera completa, así que la suma de la tabla puede quedar por debajo." });
  }
  if (tramos.length && tramosFact.length) {
    n.push({ titulo: "Los dos aging usan columnas distintas",
      cuerpo: "El de cobranza sale de " + Q.c("agingTramo") + " y el de facturación de " +
              Q.c("tramoFacturacion") + ". Los tramos pueden no coincidir, y no se suman." });
  }
  return n.map((x, i) => ({ n: String(i + 1).padStart(2, "0"), ...x }));
}

/* ══ utilidades ══════════════════════════════════════════════════════════ */

/** Un valor de dimensión legible, o null si no lo es. */
function etiquetaDe(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
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

const requiere = { medidas: ["deudaTotal", "deudaCobranza"], columnas: [] };

module.exports = { meta, consultas, construir, requiere };
