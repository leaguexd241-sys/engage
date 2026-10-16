'use strict';

/**
 * Caché LRU con caducidad (TTL) y tamaño máximo.
 * Nunca crece más allá de `max` entradas, así que no puede provocar fugas de memoria.
 */
class LruCache {
  constructor({ max = 500, ttlMs = 60_000 } = {}) {
    this.max = Math.max(1, max);
    this.ttl = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresca la posición (más reciente al final)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttl) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    return this;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  /** Elimina las entradas caducadas. */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (entry.exp <= now) this.map.delete(key);
    }
  }

  get size() {
    return this.map.size;
  }
}

module.exports = { LruCache };
