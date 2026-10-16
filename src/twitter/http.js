'use strict';

const { XError } = require('./errors');

const MAX_BODY = 4 * 1024 * 1024;

/** Lee el cuerpo con un límite de tamaño para no cargar respuestas gigantes en memoria. */
async function readLimited(res, maxBytes = MAX_BODY) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new XError('UNAVAILABLE', 'Respuesta demasiado grande');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/**
 * GET con timeout. Devuelve {status, text, headers}. Nunca lanza por códigos HTTP,
 * sólo por errores de red/timeout (como XError UNAVAILABLE).
 */
async function httpGet(url, { timeoutMs = 9000, userAgent, accept = 'application/json, text/html;q=0.9', fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'user-agent': userAgent || 'Mozilla/5.0', accept, 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new XError('UNAVAILABLE', timeout ? 'Tiempo de espera agotado' : `Error de red: ${err.message}`);
  }
  let text;
  try {
    text = await readLimited(res);
  } catch (err) {
    if (err instanceof XError) throw err;
    throw new XError('UNAVAILABLE', `No se pudo leer la respuesta: ${err.message}`);
  }
  return { status: res.status, text, headers: res.headers };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { httpGet, readLimited, parseJson };
