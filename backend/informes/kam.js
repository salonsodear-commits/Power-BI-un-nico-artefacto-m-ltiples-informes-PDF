"use strict";
/** Informe por Cliente (KAM) · facturación, costos y margen de la cartera. */
const { consultarVarias } = require("../powerbi/client");
const Q = require("../powerbi/queries");
const { limpiar, kpi } = require("./comun");
const { nombreCorto, refs } = require("./ejecutivo");

const meta = {
  nombre: "KAM",
  titulo: "Informe por Cliente (KAM)",
  bajada: "Facturación, costos y margen por cliente de la cartera, con foco en el resultado del período.",
  fuente: "Power BI — Cartera KAM"
};

const MEDIDAS_KPI = ["facturacion", "costos", "margen", "margenPct", "clientesActivos"];
const MEDIDAS_FILA = ["facturacion", "costos", "margen", "margenPct", "variacion"];

function consultas(p) {
  const q = {};
  const fila = Q.filaMedidas(MEDIDAS_KPI);
  if (fila) q.kpis = Q.filaConFiltros(fila, p);

  const cols = Q.colsMedidas(MEDIDAS_FILA);
  if (cols.length && Q.c("clienteNombre")) {
    const dims = [Q.c("clienteNombre"), Q.c("clienteKam")].filter(Boolean);
    q.clientes = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n${dims.map((x) => "    " + x).join(",\n")},\n` +
      `${Q.filtrosSC(p)}${cols.join(",\n")}\n  )\n` +
      `  ORDER BY ${Q.m("facturacion") ? "[facturacion]" : "[" + MEDIDAS_FILA.find((k) => Q.m(k)) + "]"} DESC`;
  }
  return q;
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = (d.kpis || [])[0] || {};
  const colCli = nombreCorto(Q.c("clienteNombre"));
  const colKam = Q.c("clienteKam") ? nombreCorto(Q.c("clienteKam")) : null;
  const cl = (d.clientes || []).filter((f) => f[colCli] !== undefined);

  const columnas = [
    { clave: "cliente", titulo: "Cliente", tipo: "texto" },
    colKam ? { clave: "kam", titulo: "KAM", tipo: "texto" } : null,
    Q.m("facturacion") && { clave: "facturacion", titulo: "Facturación", tipo: "monto" },
    Q.m("costos") && { clave: "costos", titulo: "Costos", tipo: "monto" },
    Q.m("margen") && { clave: "margen", titulo: "Margen", tipo: "monto" },
    Q.m("margenPct") && { clave: "margenPct", titulo: "Margen %", tipo: "pct" },
    Q.m("variacion") && { clave: "vsBo", titulo: "vs BO", tipo: "monto", firmado: true, colorear: true }
  ].filter(Boolean);

  return limpiar([
    { tipo: "kpis", items: [
      kpi("facturacion", k, { etiqueta: "Facturación de cartera", formato: "moneda",
        titular: true, sentido: "positivo" }),
      kpi("costos", k, { etiqueta: "Costos", formato: "moneda", sentido: "negativo" }),
      kpi("margen", k, { etiqueta: "Margen", formato: "moneda", sentido: "positivo" }),
      kpi("margenPct", k, { etiqueta: "Margen %", formato: "pct", sentido: "positivo" }),
      kpi("clientesActivos", k, { etiqueta: "Clientes activos", formato: "entero" })
    ]},
    cl.length && Q.m("facturacion") ? { tipo: "barrasHorizontales",
      titulo: "Facturación por cliente", medida: refs(["facturacion"]),
      formato: "moneda", ejeEtiqueta: "Cliente",
      items: cl.slice(0, 10).map((f) => ({ etiqueta: f[colCli], valor: f.facturacion }))
    } : null,
    cl.length ? { tipo: "saltoPagina" } : null,
    cl.length ? { tipo: "tabla", titulo: "Detalle por cliente",
      medida: refs(["facturacion", "margen"]), columnas,
      filas: cl.map((f) => ({
        cliente: f[colCli], kam: colKam ? f[colKam] : undefined,
        facturacion: f.facturacion, costos: f.costos, margen: f.margen,
        margenPct: f.margenPct, vsBo: f.variacion
      })),
      total: {
        cliente: "Total cartera", kam: "", facturacion: k.facturacion, costos: k.costos,
        margen: k.margen, margenPct: k.margenPct,
        vsBo: Q.m("variacion") ? cl.reduce((a, f) => a + (f.variacion || 0), 0) : undefined
      } } : null
  ]);
}

const requiere = { medidas: ["facturacion", "margen"], columnas: ["clienteNombre"] };

module.exports = { meta, consultas, construir, requiere };
