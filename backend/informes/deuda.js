"use strict";
/**
 * Informe de Deuda y Cobranzas.
 *
 * Refleja la semántica del tablero: la cartera es una FOTO, no un acumulado
 * mensual, así que los totales y el aging no se filtran por período. Filtrar
 * por mes recortaría a las facturas que vencen en ese mes, que es otra cosa.
 * El corte lo dan la sociedad, el negocio y el canal, como en el tablero.
 */
const { consultarVarias } = require("../powerbi/client");
const Q = require("../powerbi/queries");
const { limpiar, kpi } = require("./comun");
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

/** Los cortes que el usuario haya pedido, si están mapeados. */
const cortes = (p) => Q.fDimensiones(p).map((x) => "    " + x);

function consultas(p) {
  const q = {};
  const dims = cortes(p);
  const conFiltros = (cuerpo) => dims.length ? cuerpo + ",\n" + dims.join(",\n") : cuerpo;

  const fila = Q.filaMedidas(MEDIDAS_KPI);
  if (fila) {
    q.kpis = dims.length
      ? `\nEVALUATE\n  CALCULATETABLE(\n    ROW(\n${fila}\n    ),\n${dims.join(",\n")}\n  )`
      : `\nEVALUATE\n  ROW(\n${fila}\n  )`;
  }

  const medidaDeuda = Q.m("deudaCobranza") || Q.m("deudaTotal");
  if (medidaDeuda && Q.c("agingTramo")) {
    q.tramos = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n` +
      conFiltros(`    ${Q.c("agingTramo")}`) +
      `,\n    "deuda", ${medidaDeuda}\n  )`;
  }
  for (const [clave, col] of [["negocio", Q.c("vertical")], ["canal", Q.c("canal")]]) {
    if (!col || !Q.m("deudaTotal")) continue;
    q[clave] = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n` + conFiltros(`    ${col}`) +
      `,\n    "deudaTotal", ${Q.m("deudaTotal")}\n  )\n  ORDER BY [deudaTotal] DESC`;
  }

  const cols = Q.colsMedidas(MEDIDAS_CLIENTE);
  if (cols.length && Q.c("clienteNombre")) {
    const dimsCliente = [Q.c("clienteNombre"), Q.c("clienteKam")].filter(Boolean)
      .map((x) => "      " + x).join(",\n");
    const orden = Q.m("deudaTotal") ? "[deudaTotal]" : "[" + MEDIDAS_CLIENTE.find((k) => Q.m(k)) + "]";
    // TOPN acota lo que viaja: la cartera puede tener miles de clientes
    q.clientes = `\nEVALUATE\n  TOPN(\n    15,\n    SUMMARIZECOLUMNS(\n${dimsCliente},\n` +
      (dims.length ? dims.map((x) => "  " + x).join(",\n") + ",\n" : "") +
      cols.map((x) => "  " + x).join(",\n") + `\n    ),\n    ${orden}, DESC\n  )\n  ORDER BY ${orden} DESC`;
  }
  return q;
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = (d.kpis || [])[0] || {};
  const colCli = nombreCorto(Q.c("clienteNombre"));
  const colKam = Q.c("clienteKam") ? nombreCorto(Q.c("clienteKam")) : null;
  const cl = (d.clientes || []).filter((f) => f[colCli] !== undefined);

  const vencidaPct = typeof k.deudaVencida === "number" && k.deudaTotal
    ? (k.deudaVencida / k.deudaTotal) * 100 : undefined;

  const ranking = (filas, col, valor) => (filas || [])
    .map((f) => ({ etiqueta: f[nombreCorto(col)], valor: f[valor] }))
    .filter((x) => x.etiqueta !== undefined && typeof x.valor === "number");

  const columnas = [
    { clave: "cliente", titulo: "Cliente", tipo: "texto" },
    colKam ? { clave: "gestor", titulo: "Gestor", tipo: "texto" } : null,
    Q.m("deudaTotal") && { clave: "total", titulo: "Deuda total", tipo: "monto" },
    Q.m("deudaCobranza") && { clave: "cobranza", titulo: "Cobranza", tipo: "monto" },
    Q.m("deudaFacturacion") && { clave: "facturacion", titulo: "Facturación", tipo: "monto" },
    Q.m("deudaVencida") && { clave: "vencida", titulo: "Vencida", tipo: "monto" },
    Q.m("deudaVencida") && Q.m("deudaTotal") && { clave: "pctVencida", titulo: "% vencido", tipo: "pct" }
  ].filter(Boolean);

  return limpiar([
    { tipo: "kpis", items: [
      kpi("deudaTotal", k, { etiqueta: "Deuda total", formato: "moneda", titular: true,
        nota: "Cobranza + facturación pendiente" }),
      kpi("deudaCobranza", k, { etiqueta: "Deuda de cobranza", formato: "moneda", sentido: "negativo" }),
      kpi("deudaFacturacion", k, { etiqueta: "Pendiente de facturar", formato: "moneda", sentido: "negativo" }),
      kpi("deudaVencida", k, { etiqueta: "Deuda vencida", formato: "moneda",
        nota: vencidaPct === undefined ? undefined
          : new Intl.NumberFormat("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
              .format(vencidaPct) + " % de la cartera" }),
      kpi("indiceRiesgo", k, { etiqueta: "Índice de riesgo", formato: "pct", sentido: "negativo" }),
      kpi("clientesActivos", k, { etiqueta: "Clientes", formato: "entero" })
    ]},
    (d.tramos || []).length ? { tipo: "barrasHorizontales",
      titulo: "Deuda por tramo de vencimiento",
      subtitulo: "Cartera completa, sin corte de período",
      medida: refs(["deudaCobranza"]) || refs(["deudaTotal"]), formato: "moneda",
      ejeEtiqueta: "Tramo",
      items: ordenarTramos(ranking(d.tramos, Q.c("agingTramo"), "deuda")),
      nota: "El aging es una foto al momento de la última actualización del modelo." } : null,
    (d.negocio || []).length ? { tipo: "barrasHorizontales", titulo: "Deuda por negocio",
      medida: refs(["deudaTotal"]), formato: "moneda", ejeEtiqueta: "Negocio",
      items: ranking(d.negocio, Q.c("vertical"), "deudaTotal") } : null,
    (d.canal || []).length ? { tipo: "barrasHorizontales", titulo: "Deuda por canal",
      medida: refs(["deudaTotal"]), formato: "moneda", ejeEtiqueta: "Canal",
      items: ranking(d.canal, Q.c("canal"), "deudaTotal") } : null,
    cl.length ? { tipo: "saltoPagina" } : null,
    cl.length && Q.m("deudaTotal") ? { tipo: "barrasHorizontales",
      titulo: "Concentración por cliente", subtitulo: "Los 15 de mayor deuda",
      medida: refs(["deudaTotal"]), formato: "moneda", ejeEtiqueta: "Cliente",
      items: cl.slice(0, 12).map((f) => ({ etiqueta: f[colCli], valor: f.deudaTotal })) } : null,
    cl.length ? { tipo: "tabla", titulo: "Detalle por cliente",
      medida: refs(["deudaTotal", "deudaVencida"]), columnas,
      filas: cl.map((f) => ({
        cliente: f[colCli], gestor: colKam ? f[colKam] : undefined,
        total: f.deudaTotal, cobranza: f.deudaCobranza,
        facturacion: f.deudaFacturacion, vencida: f.deudaVencida,
        pctVencida: typeof f.deudaVencida === "number" && f.deudaTotal
          ? (f.deudaVencida / f.deudaTotal) * 100 : undefined
      })),
      total: { cliente: "Total cartera", gestor: "", total: k.deudaTotal,
        cobranza: k.deudaCobranza, facturacion: k.deudaFacturacion,
        vencida: k.deudaVencida, pctVencida: vencidaPct },
      nota: "Ordenado por deuda total. La consulta trae los 15 primeros." } : null
  ]);
}

/** «0-30» antes que «31-60» antes que «+90», con «A vencer» primero. */
function ordenarTramos(items) {
  const peso = (e) => {
    const s = String(e).toLowerCase();
    if (/no vencid|a vencer|por vencer|corriente/.test(s)) return -1;
    const n = s.match(/\d+/);
    return n ? Number(n[0]) : 9999;
  };
  return items.slice().sort((a, b) => peso(a.etiqueta) - peso(b.etiqueta));
}

const requiere = { medidas: ["deudaTotal", "deudaCobranza"], columnas: [] };

module.exports = { meta, consultas, construir, requiere };
