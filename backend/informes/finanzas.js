"use strict";
/** Informe de Finanzas · Real vs BO, OPEX, provisiones, aging y DSO. */
const { consultarVarias } = require("../powerbi/client");
const { claveMes, filtros, filtrosSinMes, ventanaMeses } = require("../powerbi/queries");

const MES_CORTO = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const etiquetaMes = (c) => MES_CORTO[(c % 100) - 1] + " " + String(Math.floor(c / 100)).slice(2);
const TRAMOS = ["0–30 días", "31–60 días", "61–90 días", "Más de 90 días"];

const meta = {
  nombre: "Finanzas",
  titulo: "Informe de Finanzas",
  bajada: "Real contra BO, estructura de OPEX, provisiones, pendiente de facturar, aging y DSO.",
  fuente: "Power BI — Real vs BO / OPEX"
};

function consultas(p) {
  return {
    kpis: `
EVALUATE
  CALCULATETABLE(
    ROW(
      "Real",        [Real],
      "BO",          [BO],
      "Variacion",   [Variación],
      "OPEX",        [OPEX],
      "OpexBO",      [OPEX BO],
      "Provisiones", [Provisiones],
      "PendFact",    [Pendiente de facturar],
      "DSO",         [DSO]
    ),
${filtros(p)}
  )`,
    opex: `
EVALUATE
  SUMMARIZECOLUMNS(
    Gastos[Categoria],
    FILTER(ALL(Calendario), Calendario[ClaveMes] = ${claveMes(p.periodo)}),
    "OPEX", [OPEX]
  )
  ORDER BY [OPEX] DESC`,
    aging: `
EVALUATE
  SUMMARIZECOLUMNS(
    Vertical[Nombre],
    Aging[Tramo],
    FILTER(ALL(Calendario), Calendario[ClaveMes] = ${claveMes(p.periodo)}),
    "Saldo", [Saldo CxC]
  )`,
    dso: `
EVALUATE
  SUMMARIZECOLUMNS(
    Calendario[ClaveMes],
    FILTER(ALL(Calendario), Calendario[ClaveMes] IN {${ventanaMeses(p.periodo, 12).join(", ")}}),${filtrosSinMes(p)}
    "DSO", [DSO]
  )
  ORDER BY Calendario[ClaveMes]`
  };
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = d.kpis[0] || {};
  const dso = d.dso || [];

  // el aging viene largo (vertical × tramo) y se pivotea a una serie por tramo
  const verticales = [...new Set((d.aging || []).map((f) => f.Nombre))];
  const saldo = (v, t) => {
    const f = (d.aging || []).find((x) => x.Nombre === v && x.Tramo === t);
    return f ? f.Saldo : 0;
  };
  const totalCartera = (d.aging || []).reduce((a, f) => a + (f.Saldo || 0), 0);
  const total90 = (d.aging || [])
    .filter((f) => f.Tramo === TRAMOS[3]).reduce((a, f) => a + (f.Saldo || 0), 0);

  return [
    { tipo: "kpis", items: [
      { etiqueta: "Facturación real", valor: k.Real, formato: "moneda", titular: true,
        delta: k.Variacion, deltaEtiqueta: "vs BO", sentido: "positivo" },
      { etiqueta: "Objetivo (BO)", valor: k.BO, formato: "moneda", nota: "Presupuesto vigente" },
      { etiqueta: "OPEX", valor: k.OPEX, formato: "moneda",
        delta: k.OpexBO != null ? k.OPEX - k.OpexBO : undefined,
        deltaEtiqueta: "vs BO", sentido: "negativo" },
      { etiqueta: "Provisiones", valor: k.Provisiones, formato: "moneda", sentido: "negativo" },
      { etiqueta: "Pendiente de facturar", valor: k.PendFact, formato: "moneda" },
      { etiqueta: "DSO", valor: k.DSO, formato: "dias", sentido: "negativo" }
    ]},
    { tipo: "barrasHorizontales", titulo: "OPEX por categoría", medida: "[OPEX]",
      formato: "moneda", ejeEtiqueta: "Categoría",
      items: (d.opex || []).map((f) => ({ etiqueta: f.Categoria, valor: f.OPEX })) },
    { tipo: "saltoPagina" },
    { tipo: "barrasApiladas", titulo: "Aging de cuentas por cobrar",
      subtitulo: "Saldo por tramo de vencimiento", medida: "[Saldo CxC]",
      formato: "moneda", rampa: "ordinal", ejeEtiqueta: "Vertical",
      ejeX: verticales,
      series: TRAMOS.map((t) => ({ nombre: t, datos: verticales.map((v) => saldo(v, t)) })),
      nota: totalCartera
        ? `El tramo de más de 90 días representa el ${(total90 / totalCartera * 100).toFixed(1).replace(".", ",")} % de la cartera.`
        : undefined },
    { tipo: "lineas", titulo: "Evolución del DSO", subtitulo: "Días de venta pendientes de cobro",
      medida: "[DSO]", formato: "dias", formatoEje: "entero", ejeEtiqueta: "Mes",
      ejeX: dso.map((f) => etiquetaMes(f.ClaveMes)),
      series: [{ nombre: "DSO", datos: dso.map((f) => f.DSO) }] },
    { tipo: "tabla", titulo: "Aging por vertical", medida: "[Saldo CxC]",
      columnas: [
        { clave: "vertical", titulo: "Vertical", tipo: "texto" },
        { clave: "t1", titulo: "0–30", tipo: "monto" }, { clave: "t2", titulo: "31–60", tipo: "monto" },
        { clave: "t3", titulo: "61–90", tipo: "monto" }, { clave: "t4", titulo: "+90", tipo: "monto" },
        { clave: "total", titulo: "Total", tipo: "monto" },
        { clave: "pct90", titulo: "% +90", tipo: "pct" }
      ],
      filas: verticales.map((v) => {
        const t = TRAMOS.map((x) => saldo(v, x));
        const suma = t.reduce((a, b) => a + b, 0);
        return { vertical: v, t1: t[0], t2: t[1], t3: t[2], t4: t[3], total: suma,
                 pct90: suma ? (t[3] / suma) * 100 : 0 };
      }),
      total: {
        vertical: "Total",
        ...Object.fromEntries(TRAMOS.map((t, i) => ["t" + (i + 1),
          verticales.reduce((a, v) => a + saldo(v, t), 0)])),
        total: totalCartera,
        pct90: totalCartera ? (total90 / totalCartera) * 100 : 0
      }}
  ];
}

module.exports = { meta, consultas, construir };
