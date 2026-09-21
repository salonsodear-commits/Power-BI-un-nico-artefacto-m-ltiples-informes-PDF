"use strict";
/**
 * Informe Ejecutivo · KPIs, evolución Real vs BO, desvíos y cierre.
 * Las medidas las calcula Power BI; acá sólo se acomodan en secciones.
 */
const { consultarVarias } = require("../powerbi/client");
const Q = require("../powerbi/queries");
const { etiquetaMes, limpiar, variacion, variacionPct, kpi } = require("./comun");

const meta = {
  nombre: "Ejecutivo",
  titulo: "Informe Ejecutivo",
  bajada: "Resultado del período contra objetivo, desvíos por vertical y lectura de cierre.",
  fuente: "Power BI — Real vs BO"
};

const MEDIDAS_KPI = ["real", "bo", "variacion", "variacionPct", "ebitda", "margenEbitda"];

function consultas(p) {
  const q = {};
  const fila = Q.filaMedidas(MEDIDAS_KPI);
  if (fila) q.kpis = Q.filaConFiltros(fila, p);

  const evo = Q.colsMedidas(["real", "bo"]);
  if (evo.length && Q.c("periodo")) {
    q.evolucion = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("periodo")},\n` +
      Q.filtrosSC(p, { ventana: 12 }) +
      `${evo.join(",\n")}\n  )\n  ORDER BY ${Q.c("periodo")}`;
  }

  const ver = Q.colsMedidas(["real", "bo", "variacion", "variacionPct"]);
  if (ver.length && Q.c("vertical")) {
    q.verticales = `\nEVALUATE\n  SUMMARIZECOLUMNS(\n    ${Q.c("vertical")},\n` +
      `${Q.filtrosSC(p)}${ver.join(",\n")}\n  )`;
  }
  return q;
}

async function construir(p) {
  const d = await consultarVarias(p.workspaceId, p.datasetId, consultas(p));
  const k = (d.kpis || [])[0] || {};
  const evo = d.evolucion || [];
  const ver = d.verticales || [];
  const colPeriodo = Q.c("periodo");
  const ejeX = evo.map((f) => etiquetaMes(f[nombreCorto(colPeriodo)]));
  const desv = variacion(k), desvPct = variacionPct(k);

  const filasVer = ver.map((f) => {
    const v = variacion(f), vp = variacionPct(f);
    return { nombre: f[nombreCorto(Q.c("vertical"))], real: f.real, bo: f.bo,
             desvio: v, desvioPct: vp };
  }).filter((f) => f.nombre !== undefined);

  return limpiar([
    { tipo: "kpis", items: [
      kpi("real", k, { etiqueta: "Facturación real", formato: "moneda", titular: true,
        delta: desv, deltaEtiqueta: "vs BO", sentido: "positivo",
        serie: evo.slice(-8).map((f) => f.real).filter((x) => typeof x === "number") }),
      kpi("bo", k, { etiqueta: "Objetivo (BO)", formato: "moneda", nota: "Presupuesto vigente" }),
      desv === undefined ? null : { etiqueta: "Desvío vs BO", valor: desv, formato: "moneda",
        delta: desvPct, formatoDelta: "pp", deltaEtiqueta: "sobre objetivo", sentido: "positivo" },
      kpi("ebitda", k, { etiqueta: "EBITDA", formato: "moneda", sentido: "positivo" }),
      kpi("margenEbitda", k, { etiqueta: "Margen EBITDA", formato: "pct", sentido: "positivo" })
    ]},
    ejeX.length ? { tipo: "barras", titulo: "Evolución Real vs BO", subtitulo: "Últimos 12 meses",
      medida: refs(["real", "bo"]), formato: "moneda", formatoEje: "monto", ejeEtiqueta: "Mes",
      ejeX,
      series: [
        Q.m("real") && { nombre: "Real", datos: evo.map((f) => f.real) },
        Q.m("bo") && { nombre: "BO", datos: evo.map((f) => f.bo) }
      ].filter(Boolean) } : null,
    filasVer.length ? { tipo: "desvios", titulo: "Desvíos por vertical",
      subtitulo: "Real contra objetivo del mes", medida: refs(["variacion"]) || refs(["real", "bo"]),
      formato: "moneda",
      items: filasVer.filter((f) => f.desvio !== undefined).map((f) => ({
        concepto: f.nombre, real: f.real, bo: f.bo,
        desvio: f.desvio, desvioPct: f.desvioPct, favorable: f.desvio >= 0
      })) } : null,
    filasVer.length ? { tipo: "tabla", titulo: "Real vs BO por vertical",
      medida: refs(["real", "bo", "variacion"]),
      columnas: [
        { clave: "vertical", titulo: "Vertical", tipo: "texto" },
        { clave: "real", titulo: "Real", tipo: "monto" },
        { clave: "bo", titulo: "BO", tipo: "monto" },
        { clave: "desvio", titulo: "Desvío", tipo: "monto", firmado: true, colorear: true },
        { clave: "desvioPct", titulo: "Desvío %", tipo: "pct", firmado: true, colorear: true },
        { clave: "estado", titulo: "Situación", tipo: "estado" }
      ],
      filas: filasVer.map((f) => ({ vertical: f.nombre, real: f.real, bo: f.bo,
        desvio: f.desvio, desvioPct: f.desvioPct, estado: (f.desvio || 0) >= 0 })),
      total: { vertical: "Total", real: k.real, bo: k.bo,
        desvio: desv, desvioPct: desvPct, estado: (desv || 0) >= 0 } } : null
  ]);
}

/** `Vertical[Nombre]` → `Nombre`, que es como lo devuelve el cliente. */
const nombreCorto = (ref) => {
  const x = String(ref || "").match(/\[([^\]]+)\]\s*$/);
  return x ? x[1] : ref;
};
/** Muestra en el informe qué medidas del modelo lo alimentan. */
const refs = (claves) => {
  const r = claves.map((k) => Q.m(k)).filter(Boolean);
  return r.length ? r.join(" · ") : undefined;
};

const requiere = { medidas: ["real", "bo"], columnas: ["periodo"] };

module.exports = { meta, consultas, construir, requiere, nombreCorto, refs, MEDIDAS_KPI };
