"use strict";
/**
 * Cómo se suelen llamar las cosas en un modelo financiero, en español y en
 * inglés. Es el diccionario que permite deducir el mapeo sin que nadie
 * escriba nombres a mano.
 *
 * El orden importa: se prueba de arriba hacia abajo y se corta en el primer
 * acierto, así que primero va lo más específico y lo más probable.
 */

/** Tablas, por el papel que cumplen. Se prueban con EVALUATE TOPN(1, T). */
const TABLAS = {
  calendario: ["Calendario", "Dim_Calendario", "Dim Calendario", "DimCalendario",
    "Fecha", "Fechas", "Dim_Fecha", "Dim Fecha", "DimFecha",
    "Date", "Dates", "Dim_Date", "DimDate", "Tiempo", "Tabla de fechas"],
  sociedad: ["Sociedad", "Sociedades", "Dim_Sociedad", "Dim Sociedad",
    "Empresa", "Empresas", "Compania", "Compañia", "Compañía", "Entidad"],
  vertical: ["Vertical", "Verticales", "Dim_Vertical", "Dim Vertical",
    "Unidad de Negocio", "UnidadNegocio", "Dim_UN", "Dim UN", "UN",
    "Negocio", "Segmento", "Division", "División", "Area", "Área"],
  cliente: ["Cliente", "Clientes", "Dim_Cliente", "Dim Cliente", "DimCliente",
    "Customer", "Customers", "Cuenta", "Cuentas"],
  gastos: ["Gastos", "Gasto", "OPEX", "Dim_Gasto", "Dim Gasto",
    "Categoria de Gasto", "Categorias", "Conceptos", "Concepto"],
  aging: ["Aging", "Vencimientos", "Vencimiento", "Tramos", "Tramo",
    "Antiguedad", "Antigüedad", "Dim_Aging"]
};

/**
 * Columnas dentro de una tabla ya encontrada. Se busca sobre los nombres que
 * devolvió TOPN, sin costo extra de consultas.
 */
const COLUMNAS = {
  // el período tiene que ser a nivel mes; el valor se valida aparte
  periodo: [/^periodo$/i, /^per[ií]odo$/i, /a[ñn]o[\s_-]*mes/i, /^anio[\s_]*mes$/i,
    /year[\s_-]*month/i, /^yyyymm$/i, /clave[\s_]*mes/i, /^mes[\s_]*a[ñn]o$/i,
    /^id[\s_]*mes$/i, /month[\s_-]*key/i],
  nombre: [/^nombre$/i, /^descripci[oó]n$/i, /^descripcion$/i, /^raz[oó]n social$/i,
    /^name$/i, /^description$/i, /^desc$/i, /^detalle$/i],
  kam: [/^kam$/i, /responsable/i, /ejecutiv/i, /vendedor/i, /^owner$/i, /account manager/i],
  categoria: [/^categor[ií]a$/i, /^concepto$/i, /^rubro$/i, /^tipo$/i, /^category$/i],
  tramo: [/^tramo$/i, /^rango$/i, /antig[üu]edad/i, /^bucket$/i, /^vencimiento$/i]
};

/** Medidas, por el papel que cumplen en los informes. */
const MEDIDAS = {
  real: ["Real", "Facturación", "Facturacion", "Facturación Neta", "Facturacion Neta",
    "Ventas", "Venta", "Ventas Netas", "Ingresos", "Ingreso",
    "Total Facturado", "Actual", "Revenue", "Sales"],
  bo: ["BO", "Presupuesto", "Objetivo", "Ppto", "Budget", "Plan", "Meta",
    "Presupuestado", "Forecast", "Pronóstico", "Pronostico", "Target"],
  variacion: ["Variación", "Variacion", "Desvío", "Desvio", "Diferencia",
    "Var", "Variance", "Delta", "Real vs BO"],
  variacionPct: ["Variación %", "Variacion %", "Desvío %", "Desvio %", "Var %",
    "% Variación", "% Variacion", "Variance %", "Cumplimiento %"],
  ebitda: ["EBITDA", "Ebitda", "EBITDA Ajustado", "Resultado Operativo", "EBIT"],
  margenEbitda: ["Margen EBITDA %", "Margen EBITDA", "% EBITDA", "EBITDA %",
    "Mg EBITDA %", "Mg EBITDA"],
  opex: ["OPEX", "Opex", "Gastos", "Gastos Operativos", "Costos Operativos",
    "Gasto Operativo", "Egresos"],
  opexBo: ["OPEX BO", "OPEX Presupuesto", "Gastos BO", "Gastos Presupuesto",
    "OPEX Objetivo", "Opex Ppto"],
  provisiones: ["Provisiones", "Provisión", "Provision", "Previsiones", "Previsión"],
  pendienteFacturar: ["Pendiente de facturar", "Pendiente Facturar", "Por Facturar",
    "A Facturar", "Pendiente de Facturación", "WIP", "Obra en curso"],
  dso: ["DSO", "Días de cobro", "Dias de cobro", "Días de Cobranza", "Days Sales Outstanding"],
  saldoCxC: ["Saldo CxC", "CxC", "Cuentas por Cobrar", "Saldo Cuentas por Cobrar",
    "Deuda", "Saldo Deuda", "Saldo", "Cobranzas Pendientes", "Accounts Receivable"],
  facturacion: ["Facturación", "Facturacion", "Ventas", "Ingresos", "Facturado",
    "Revenue", "Total Facturado"],
  costos: ["Costos", "Costo", "Costos Totales", "Costo Total", "CMV", "COGS",
    "Costo de Ventas"],
  margen: ["Margen", "Margen Bruto", "Contribución", "Contribucion",
    "Margen de Contribución", "Gross Margin", "Resultado"],
  margenPct: ["Margen %", "% Margen", "Margen Bruto %", "% de Margen",
    "Margen sobre Ventas", "Gross Margin %"],
  clientesActivos: ["Clientes activos", "Clientes Activos", "Clientes",
    "Cantidad de Clientes", "Nro de Clientes", "Active Customers"]
};

/** A qué tabla pertenece cada columna lógica, y qué patrón la reconoce. */
const COLUMNA_DE = {
  periodo:        { tabla: "calendario", patron: "periodo" },
  sociedad:       { tabla: "sociedad",   patron: "nombre" },
  vertical:       { tabla: "vertical",   patron: "nombre" },
  gastoCategoria: { tabla: "gastos",     patron: "categoria" },
  agingTramo:     { tabla: "aging",      patron: "tramo" },
  clienteNombre:  { tabla: "cliente",    patron: "nombre" },
  clienteKam:     { tabla: "cliente",    patron: "kam" }
};

module.exports = { TABLAS, COLUMNAS, MEDIDAS, COLUMNA_DE };
