'use strict';

const { LruCache } = require('./lru');

/**
 * Enfriamiento por clave (usuario, acción...).
 * `hit(key, ms)` devuelve 0 si la acción está permitida (y la registra)
 * o los milisegundos que faltan si todavía está en enfriamiento.
 */
class Cooldown {
  constructor(max = 20_000) {
    this.cache = new LruCache({ max, ttlMs: 60_000 });
  }

  hit(key, ms) {
    const now = Date.now();
    const until = this.cache.get(key);
    if (until && until > now) return until - now;
    this.cache.set(key, now + ms, ms);
    return 0;
  }

  clear(key) {
    this.cache.delete(key);
  }
}

/** Limitador de ventana fija: como máximo `max` intentos cada `windowMs`. */
class WindowLimiter {
  constructor({ windowMs = 60_000, max = 10, maxKeys = 10_000 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.cache = new LruCache({ max: maxKeys, ttlMs: windowMs });
  }

  /** @returns {boolean} true si se permite el intento */
  check(key) {
    const now = Date.now();
    let entry = this.cache.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + this.windowMs };
    }
    entry.count += 1;
    this.cache.set(key, entry, Math.max(1, entry.reset - now));
    return entry.count <= this.max;
  }

  retryAfter(key) {
    const entry = this.cache.get(key);
    return entry ? Math.max(0, entry.reset - Date.now()) : 0;
  }

  reset(key) {
    this.cache.delete(key);
  }
}

/** Candado simple por clave para evitar operaciones duplicadas en paralelo. */
class KeyedLock {
  constructor() {
    this.held = new Set();
  }

  tryAcquire(key) {
    if (this.held.has(key)) return false;
    this.held.add(key);
    return true;
  }

  release(key) {
    this.held.delete(key);
  }

  async run(key, fn) {
    if (!this.tryAcquire(key)) return { busy: true };
    try {
      return { busy: false, value: await fn() };
    } finally {
      this.release(key);
    }
  }

  get size() {
    return this.held.size;
  }
}

module.exports = { Cooldown, WindowLimiter, KeyedLock };
