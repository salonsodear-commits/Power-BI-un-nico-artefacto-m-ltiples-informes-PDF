"use strict";
/**
 * Informe Ejecutivo · KPIs, evolución Real vs BO, desvíos y lectura de cierre.
 *
 * Las medidas las calcula Power BI: [Real], [BO], [Variación], [EBITDA]…
 * Acá no se recalcula ninguna, sólo se acomodan en las secciones que el
 * artefacto sabe dibujar. (Manual, paso 13.)
 */
const { consultarVarias } = require("../powerbi/client");
const { claveMes, filtros, filtrosSinMes, ventanaMeses } = require("../powerbi/queries");

const MES_CORTO = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const etiquetaMes = (clave) =>
  MES_CORTO[(clave % 100) - 1] + " " + String(Math.floor(clave / 100)).slice(2);

const meta = {
  nombre: "Ejecutivo",
  titulo: "Informe Ejecutivo",
  bajada: "Resultado del período contra objetivo, desvíos por vertical y lectura de cierre.",
  fuente: "Power BI — Real vs BO"
};

function consultas(p) {
  const ventana = ventanaMeses(p.periodo, 12);
  return {
    kpis: `
EVALUATE
  CALCULATETABLE(
    ROW(
      "Real",      [Real],
      "BO",        [BO],
      "Variacion", [Variación],
      "VarPct",    [Variación %],
      "EBITDA",    [EBITDA],
      "MargenEB",  [Margen EBITDA %]
    ),
${filtros(p)}
  )`,
    evolucion: `
EVALUATE
  SUMMARIZECOLUMNS(
    Calendario[ClaveMes],
    FILTER(ALL(Calendario), Calendario[ClaveMes] IN {${ventana.join(", ")}}),${filtrosSinMes(p)}
    "Real", [Real],
    "BO",   [BO]
  )
  ORDER BY Calendario[ClaveMes]`,
    verticales: `
EVALUATE
  SUMMARIZECOLUMNS(
    Vertical[Nombre],
    FILTER(ALL(Calendario), Calendario[ClaveMes] = ${claveMes(p.periodo)}),
    "Real",      [Real],
    "BO",        [BO],
    "Desvio",    [Variación],
    "DesvioPct", [Variación %]
  )
  ORDER BY [Real] DESC`
  };
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = d.kpis[0] || {};
  const evo = d.evolucion || [];
  const ver = d.verticales || [];

  return [
    { tipo: "kpis", items: [
      { etiqueta: "Facturación real", valor: k.Real, formato: "moneda", titular: true,
        delta: k.Variacion, deltaEtiqueta: "vs BO", sentido: "positivo",
        serie: evo.slice(-8).map((f) => f.Real) },
      { etiqueta: "Objetivo (BO)", valor: k.BO, formato: "moneda", nota: "Presupuesto vigente" },
      { etiqueta: "Desvío vs BO", valor: k.Variacion, formato: "moneda",
        delta: k.VarPct, formatoDelta: "pp", deltaEtiqueta: "sobre objetivo", sentido: "positivo" },
      { etiqueta: "EBITDA", valor: k.EBITDA, formato: "moneda", sentido: "positivo" },
      { etiqueta: "Margen EBITDA", valor: k.MargenEB, formato: "pct", sentido: "positivo" }
    ]},
    { tipo: "barras", titulo: "Evolución Real vs BO", subtitulo: "Últimos 12 meses",
      medida: "[Real] · [BO]", formato: "moneda", formatoEje: "monto", ejeEtiqueta: "Mes",
      ejeX: evo.map((f) => etiquetaMes(f.ClaveMes)),
      series: [
        { nombre: "Real", datos: evo.map((f) => f.Real) },
        { nombre: "BO", datos: evo.map((f) => f.BO) }
      ]},
    { tipo: "desvios", titulo: "Desvíos por vertical", subtitulo: "Real contra objetivo del mes",
      medida: "[Variación]", formato: "moneda",
      items: ver.map((f) => ({
        concepto: f.Nombre, real: f.Real, bo: f.BO,
        desvio: f.Desvio, desvioPct: f.DesvioPct, favorable: f.Desvio >= 0
      }))},
    { tipo: "tabla", titulo: "Real vs BO por vertical", medida: "[Real] · [BO] · [Variación]",
      columnas: [
        { clave: "vertical", titulo: "Vertical", tipo: "texto" },
        { clave: "real", titulo: "Real", tipo: "monto" },
        { clave: "bo", titulo: "BO", tipo: "monto" },
        { clave: "desvio", titulo: "Desvío", tipo: "monto", firmado: true, colorear: true },
        { clave: "desvioPct", titulo: "Desvío %", tipo: "pct", firmado: true, colorear: true },
        { clave: "estado", titulo: "Situación", tipo: "estado" }
      ],
      filas: ver.map((f) => ({
        vertical: f.Nombre, real: f.Real, bo: f.BO,
        desvio: f.Desvio, desvioPct: f.DesvioPct, estado: f.Desvio >= 0
      })),
      total: {
        vertical: "Total", real: k.Real, bo: k.BO,
        desvio: k.Variacion, desvioPct: k.VarPct, estado: (k.Variacion || 0) >= 0
      }}
  ];
}

module.exports = { meta, consultas, construir };
