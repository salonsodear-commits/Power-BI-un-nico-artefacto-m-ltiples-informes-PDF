"use strict";
/**
 * Registro de informes. Para sumar uno nuevo: crear el archivo con
 * { meta, consultas, construir } y agregarlo acá. El artefacto lo ve solo.
 */
module.exports = {
  ejecutivo: require("./ejecutivo"),
  finanzas: require("./finanzas"),
  kam: require("./kam"),
  gerencia: require("./gerencia")
};
