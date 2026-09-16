"use strict";
/**
 * Informe de Gerencia · lectura consolidada del período.
 * Reutiliza las secciones del ejecutivo y sólo cambia el encabezado y los KPIs:
 * agregar un informe no es copiar el anterior. (Manual, paso 19.)
 */
const ejecutivo = require("./ejecutivo");

const meta = {
  nombre: "Gerencia",
  titulo: "Informe de Gerencia",
  bajada: "Lectura consolidada del período: resultado, desvíos, cobranza y los temas abiertos.",
  fuente: "Power BI — Consolidado"
};

const consultas = ejecutivo.consultas;

async function construir(p) {
  const secciones = await ejecutivo.construir(p);
  // misma base, otro recorte de indicadores para la mesa de gerencia
  const kpis = secciones.find((s) => s.tipo === "kpis");
  if (kpis) {
    const por = (e) => kpis.items.find((i) => i.etiqueta === e);
    kpis.items = [por("Facturación real"), por("EBITDA"), por("Margen EBITDA"), por("Desvío vs BO")]
      .filter(Boolean);
  }
  return secciones;
}

const requiere = ejecutivo.requiere;

module.exports = { meta, consultas, construir, requiere };
