"use strict";
/** Informe de Finanzas · Real vs BO, OPEX, provisiones, aging y DSO. */
const { consultarVarias } = require("../powerbi/client");
const Q = require("../powerbi/queries");
const { etiquetaMes, limpiar, variacion, kpi } = require("./comun");
const { nombreCorto, refs } = require("./ejecutivo");

const meta = {
  nombre: "Finanzas",
  titulo: "Informe de Finanzas",
  bajada: "Real contra BO, estructura de OPEX, provisiones, pendiente de facturar, aging y DSO.",
  fuente: "Power BI — Real vs BO / OPEX"
};

const MEDIDAS_KPI = ["real", "bo", "variacion", "opex", "opexBo", "provisiones",
                     "pendienteFacturar", "dso"];

function consultas(p) {
  const q = {};
  const fila = Q.filaMedidas(MEDIDAS_KPI);
  if (fila) q.kpis = `\nEVALUATE\n  CALCULATETABLE(\n    ROW(\n${fila}\n    ),\n${Q.argsFiltro(p)}\n  )`;

  if (Q.m("opex") && Q.c("gastoCategoria")) {
    q.opex = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("gastoCategoria")},\n` +
      `${Q.argsFiltro(p)},\n    "opex", ${Q.m("opex")}\n  )\n  ORDER BY [opex] DESC`;
  }
  if (Q.m("saldoCxC") && Q.c("agingTramo")) {
    const dims = [Q.c("vertical"), Q.c("agingTramo")].filter(Boolean);
    q.aging = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n${dims.map((x) => "    " + x).join(",\n")},\n` +
      `${Q.argsFiltro(p)},\n    "saldo", ${Q.m("saldoCxC")}\n  )`;
  }
  if (Q.m("dso") && Q.c("periodo")) {
    q.dso = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("periodo")},\n` +
      [Q.fVentana(p.periodo, 12), ...Q.fDimensiones(p)].map((x) => "    " + x).join(",\n") +
      `,\n    "dso", ${Q.m("dso")}\n  )\n  ORDER BY ${Q.c("periodo")}`;
  }
  return q;
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = (d.kpis || [])[0] || {};
  const dso = d.dso || [];
  const colPer = nombreCorto(Q.c("periodo"));
  const colVer = nombreCorto(Q.c("vertical"));
  const colTramo = nombreCorto(Q.c("agingTramo"));

  // el aging viene largo (vertical × tramo) y se pivotea a una serie por tramo
  const aging = d.aging || [];
  const verticales = [...new Set(aging.map((f) => f[colVer]).filter((x) => x !== undefined))];
  const tramos = [...new Set(aging.map((f) => f[colTramo]).filter((x) => x !== undefined))].sort(ordenTramo);
  const saldo = (v, t) => {
    const f = aging.find((x) => x[colVer] === v && x[colTramo] === t);
    return f ? (f.saldo || 0) : 0;
  };
  const totalCartera = aging.reduce((a, f) => a + (f.saldo || 0), 0);
  const ultimoTramo = tramos[tramos.length - 1];
  const totalUltimo = aging.filter((f) => f[colTramo] === ultimoTramo)
    .reduce((a, f) => a + (f.saldo || 0), 0);

  return limpiar([
    { tipo: "kpis", items: [
      kpi("real", k, { etiqueta: "Facturación real", formato: "moneda", titular: true,
        delta: variacion(k), deltaEtiqueta: "vs BO", sentido: "positivo" }),
      kpi("bo", k, { etiqueta: "Objetivo (BO)", formato: "moneda", nota: "Presupuesto vigente" }),
      kpi("opex", k, { etiqueta: "OPEX", formato: "moneda", sentido: "negativo",
        delta: typeof k.opexBo === "number" && typeof k.opex === "number" ? k.opex - k.opexBo : undefined,
        deltaEtiqueta: "vs BO" }),
      kpi("provisiones", k, { etiqueta: "Provisiones", formato: "moneda", sentido: "negativo" }),
      kpi("pendienteFacturar", k, { etiqueta: "Pendiente de facturar", formato: "moneda" }),
      kpi("dso", k, { etiqueta: "DSO", formato: "dias", sentido: "negativo" })
    ]},
    (d.opex || []).length ? { tipo: "barrasHorizontales", titulo: "OPEX por categoría",
      medida: refs(["opex"]), formato: "moneda", ejeEtiqueta: "Categoría",
      items: d.opex.map((f) => ({ etiqueta: f[nombreCorto(Q.c("gastoCategoria"))], valor: f.opex }))
    } : null,
    verticales.length && tramos.length ? { tipo: "saltoPagina" } : null,
    verticales.length && tramos.length ? { tipo: "barrasApiladas",
      titulo: "Aging de cuentas por cobrar", subtitulo: "Saldo por tramo de vencimiento",
      medida: refs(["saldoCxC"]), formato: "moneda", rampa: "ordinal", ejeEtiqueta: "Vertical",
      ejeX: verticales,
      series: tramos.map((t) => ({ nombre: String(t), datos: verticales.map((v) => saldo(v, t)) })),
      nota: totalCartera ? `El tramo «${ultimoTramo}» representa el ` +
        `${(totalUltimo / totalCartera * 100).toFixed(1).replace(".", ",")} % de la cartera.` : undefined
    } : null,
    dso.length ? { tipo: "lineas", titulo: "Evolución del DSO",
      subtitulo: "Días de venta pendientes de cobro", medida: refs(["dso"]),
      formato: "dias", formatoEje: "entero", ejeEtiqueta: "Mes",
      ejeX: dso.map((f) => etiquetaMes(f[colPer])),
      series: [{ nombre: "DSO", datos: dso.map((f) => f.dso) }] } : null,
    verticales.length && tramos.length ? { tipo: "tabla", titulo: "Aging por vertical",
      medida: refs(["saldoCxC"]),
      columnas: [
        { clave: "vertical", titulo: "Vertical", tipo: "texto" },
        ...tramos.map((t, i) => ({ clave: "t" + i, titulo: String(t), tipo: "monto" })),
        { clave: "total", titulo: "Total", tipo: "monto" }
      ],
      filas: verticales.map((v) => {
        const fila = { vertical: v };
        let suma = 0;
        tramos.forEach((t, i) => { const x = saldo(v, t); fila["t" + i] = x; suma += x; });
        fila.total = suma;
        return fila;
      }),
      total: Object.assign({ vertical: "Total", total: totalCartera },
        ...tramos.map((t, i) => ({ ["t" + i]: verticales.reduce((a, v) => a + saldo(v, t), 0) })))
    } : null
  ]);
}

/** 0–30 antes que 31–60 antes que +90, aunque vengan desordenados. */
function ordenTramo(a, b) {
  const n = (x) => { const d = String(x).match(/\d+/); return d ? Number(d[0]) : 9999; };
  return n(a) - n(b) || String(a).localeCompare(String(b), "es");
}

const requiere = { medidas: ["real", "opex", "saldoCxC", "dso"], columnas: ["periodo"] };

module.exports = { meta, consultas, construir, requiere };
