"use strict";
/** Informe por Cliente (KAM) · facturación, costos y margen de la cartera. */
const { consultarVarias } = require("../powerbi/client");
const { claveMes, filtros } = require("../powerbi/queries");

const meta = {
  nombre: "KAM",
  titulo: "Informe por Cliente (KAM)",
  bajada: "Facturación, costos y margen por cliente de la cartera, con foco en el resultado del período.",
  fuente: "Power BI — Cartera KAM"
};

function consultas(p) {
  return {
    kpis: `
EVALUATE
  CALCULATETABLE(
    ROW(
      "Facturacion", [Facturación],
      "Costos",      [Costos],
      "Margen",      [Margen],
      "MargenPct",   [Margen %],
      "Clientes",    [Clientes activos]
    ),
${filtros(p)}
  )`,
    clientes: `
EVALUATE
  SUMMARIZECOLUMNS(
    Cliente[Nombre],
    Cliente[KAM],
    FILTER(ALL(Calendario), Calendario[ClaveMes] = ${claveMes(p.periodo)}),
    "Facturacion", [Facturación],
    "Costos",      [Costos],
    "Margen",      [Margen],
    "MargenPct",   [Margen %],
    "VsBO",        [Variación]
  )
  ORDER BY [Facturacion] DESC`
  };
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = d.kpis[0] || {};
  const cl = d.clientes || [];

  return [
    { tipo: "kpis", items: [
      { etiqueta: "Facturación de cartera", valor: k.Facturacion, formato: "moneda", titular: true,
        sentido: "positivo" },
      { etiqueta: "Costos", valor: k.Costos, formato: "moneda", sentido: "negativo" },
      { etiqueta: "Margen", valor: k.Margen, formato: "moneda", sentido: "positivo" },
      { etiqueta: "Margen %", valor: k.MargenPct, formato: "pct", sentido: "positivo" },
      { etiqueta: "Clientes activos", valor: k.Clientes, formato: "entero" }
    ]},
    { tipo: "barrasHorizontales", titulo: "Facturación por cliente",
      medida: "[Facturación]", formato: "moneda", ejeEtiqueta: "Cliente",
      items: cl.slice(0, 10).map((f) => ({ etiqueta: f.Nombre, valor: f.Facturacion })) },
    { tipo: "saltoPagina" },
    { tipo: "tabla", titulo: "Detalle por cliente", medida: "[Facturación] · [Margen]",
      columnas: [
        { clave: "cliente", titulo: "Cliente", tipo: "texto" },
        { clave: "kam", titulo: "KAM", tipo: "texto" },
        { clave: "facturacion", titulo: "Facturación", tipo: "monto" },
        { clave: "costos", titulo: "Costos", tipo: "monto" },
        { clave: "margen", titulo: "Margen", tipo: "monto" },
        { clave: "margenPct", titulo: "Margen %", tipo: "pct" },
        { clave: "vsBo", titulo: "vs BO", tipo: "monto", firmado: true, colorear: true }
      ],
      filas: cl.map((f) => ({
        cliente: f.Nombre, kam: f.KAM, facturacion: f.Facturacion, costos: f.Costos,
        margen: f.Margen, margenPct: f.MargenPct, vsBo: f.VsBO
      })),
      total: {
        cliente: "Total cartera", kam: "", facturacion: k.Facturacion, costos: k.Costos,
        margen: k.Margen, margenPct: k.MargenPct,
        vsBo: cl.reduce((a, f) => a + (f.VsBO || 0), 0)
      }}
  ];
}

module.exports = { meta, consultas, construir };
