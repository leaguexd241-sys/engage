'use strict';

/** Error con un mensaje pensado para mostrarse al usuario tal cual. */
class UserError extends Error {
  constructor(message, code = 'USER', extra = {}) {
    super(message);
    this.name = 'UserError';
    this.code = code;
    this.expose = true;
    Object.assign(this, extra);
  }
}

const isUserError = (e) => e instanceof UserError;

module.exports = { UserError, isUserError };
