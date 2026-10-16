'use strict';

/**
 * Códigos:
 *  NOT_FOUND    el post/usuario no existe o fue eliminado
 *  PROTECTED    la cuenta es privada
 *  UNAVAILABLE  la fuente no respondió (red, 5xx, formato inesperado)
 *  RATE_LIMITED la fuente pidió esperar
 *  NOT_HANDLED  (interno) el proveedor no maneja este recurso
 */
class XError extends Error {
  constructor(code, message, meta = {}) {
    super(message || code);
    this.name = 'XError';
    this.code = code;
    Object.assign(this, meta);
  }
}

const isXError = (e, code) => e instanceof XError && (!code || e.code === code);

module.exports = { XError, isXError };
