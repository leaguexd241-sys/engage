'use strict';

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Código aleatorio sin caracteres ambiguos (0/O, 1/I...). */
function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function isSnowflake(v) {
  return typeof v === 'string' && /^\d{15,21}$/.test(v);
}

module.exports = { randomCode, isSnowflake };
