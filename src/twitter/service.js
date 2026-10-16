'use strict';

const { XError } = require('./errors');
const { LruCache } = require('../util/lru');
const { ConcurrencyLimiter } = require('../util/limiter');
const { createFxTwitterProvider } = require('./providers/fxtwitter');
const { createSyndicationProvider } = require('./providers/syndication');

const TTL = { tweet: 45_000, profile: 30_000, timeline: 60_000, negative: 15_000 };
const PRIORITY = { NOT_FOUND: 1, PROTECTED: 2, RATE_LIMITED: 3, UNAVAILABLE: 4 };

/**
 * Acceso a X sin API oficial.
 * - Varios proveedores públicos con respaldo automático (si uno falla, prueba el siguiente).
 * - Caché LRU limitada + deduplicación de peticiones simultáneas.
 * - Concurrencia limitada para no saturar las fuentes.
 */
class XService {
  constructor({ providers, logger, concurrency = 4, maxQueue = 500, rateLimitPauseMs = 5 * 60_000 } = {}) {
    this.providers = providers || [];
    // Si una fuente pide esperar (HTTP 429), se deja descansar un rato en vez de insistir.
    this.rateLimitPauseMs = rateLimitPauseMs;
    this.pausedUntil = new Map();
    this.log = logger;
    this.limiter = new ConcurrencyLimiter(concurrency, maxQueue);
    this.cache = new LruCache({ max: 2000, ttlMs: TTL.tweet });
    this.inflight = new Map();
    this.health = new Map();
    for (const p of this.providers) this.health.set(p.name, { ok: 0, fail: 0, lastOk: null, lastError: null, lastErrorAt: null, lastErrorCode: null, lastState: 'untested' });
  }

  static fromConfig(config, logger, { mock = null } = {}) {
    const opts = { timeoutMs: config.twitter.timeoutMs, userAgent: config.twitter.userAgent };
    const factories = { fxtwitter: createFxTwitterProvider, syndication: createSyndicationProvider };
    const providers = [];
    if (mock) providers.push(mock.provider);
    for (const name of mock ? [] : config.twitter.providers) {
      if (factories[name]) providers.push(factories[name](opts));
    }
    return new XService({ providers, logger, concurrency: config.twitter.concurrency });
  }

  _record(name, ok, err) {
    const h = this.health.get(name);
    if (!h) return;
    if (ok) {
      h.ok += 1;
      h.lastOk = Date.now();
      h.lastState = 'ok';
    } else {
      h.fail += 1;
      h.lastError = err?.message || String(err);
      h.lastErrorAt = Date.now();
      h.lastErrorCode = err?.code || 'UNAVAILABLE';
      h.lastState = 'error';
    }
  }

  async _call(kind, method, arg, { fresh = false } = {}) {
    const key = `${kind}:${String(arg).toLowerCase()}`;
    if (!fresh) {
      const cached = this.cache.get(key);
      if (cached) {
        if (cached.error) throw cached.error;
        return cached.value;
      }
    }
    const inflightKey = `${key}:${fresh ? 'f' : 'c'}`;
    if (this.inflight.has(inflightKey)) return this.inflight.get(inflightKey);

    const promise = this.limiter
      .run(() => this._tryProviders(method, arg))
      .then(
        (value) => {
          this.cache.set(key, { value }, TTL[kind]);
          return value;
        },
        (err) => {
          if (err instanceof XError && (err.code === 'NOT_FOUND' || err.code === 'PROTECTED')) {
            this.cache.set(key, { error: err }, TTL.negative);
          }
          throw err;
        },
      )
      .finally(() => this.inflight.delete(inflightKey));
    this.inflight.set(inflightKey, promise);
    return promise;
  }

  async _tryProviders(method, arg) {
    let best = null;
    for (const p of this.providers) {
      if (typeof p[method] !== 'function') continue;
      // Profile and timeline requests can share the same upstream quota.
      const pauseKey = p.name;
      const paused = this.pausedUntil.get(pauseKey);
      if (paused && paused > Date.now()) {
        if (!best || PRIORITY.RATE_LIMITED > PRIORITY[best.code]) best = new XError('RATE_LIMITED', 'Fuente en pausa por límite de peticiones', { retryAt: paused });
        continue;
      }
      try {
        const value = await p[method](arg);
        this._record(p.name, true);
        return value;
      } catch (err) {
        const e = err instanceof XError ? err : new XError('UNAVAILABLE', err?.message || String(err));
        if (e.code === 'NOT_HANDLED') continue;
        if (e.code === 'RATE_LIMITED') {
          const pauseMs = Math.max(1000, e.retryAfterMs ?? this.rateLimitPauseMs);
          e.retryAt = Date.now() + pauseMs;
          this.pausedUntil.set(pauseKey, e.retryAt);
          this.log?.warn(`[${p.name}] Rate limited; retry after ${Math.ceil(pauseMs / 1000)} seconds.`);
        }
        if (e.code === 'UNAVAILABLE' || e.code === 'RATE_LIMITED') {
          this._record(p.name, false, e);
          this.log?.debug(`[${p.name}] ${method}(${arg}) falló: ${e.message}`);
        } else {
          this._record(p.name, true);
        }
        // Nos quedamos con el error más "grave" (una caída pesa más que un no encontrado,
        // para no rechazar a nadie por culpa de una fuente caída).
        if (!best || PRIORITY[e.code] > PRIORITY[best.code]) best = e;
        // Si una fuente confirma que es privado, no hace falta seguir.
        if (e.code === 'PROTECTED') break;
      }
    }
    // Si alguna fuente dijo NOT_FOUND y otra estaba caída, preferimos UNAVAILABLE (reintentable).
    throw best || new XError('UNAVAILABLE', 'No hay fuentes de X configuradas');
  }

  getTweet(id, opts) {
    return this._call('tweet', 'getTweet', String(id), opts);
  }

  getProfile(handle, opts) {
    return this._call('profile', 'getProfile', String(handle), opts);
  }

  getTimeline(handle, opts) {
    return this._call('timeline', 'getTimeline', String(handle), opts);
  }

  /** Busca en el timeline público del usuario un repost/respuesta/cita de un post. */
  async findInTimeline(handle, tweetId, kind, opts) {
    let tl;
    try {
      tl = await this.getTimeline(handle, opts);
    } catch (err) {
      if (err instanceof XError) return { found: false, checked: false, error: err.code };
      throw err;
    }
    const id = String(tweetId);
    const item = tl.items.find((it) =>
      kind === 'repost' ? it.repostOf === id : kind === 'reply' ? it.replyTo === id : kind === 'quote' ? it.quoteOf === id : false,
    );
    return { found: Boolean(item), checked: true, item: item || null };
  }

  status() {
    const now = Date.now();
    const stateFor = (provider) => {
      const health = this.health.get(provider.name);
      if ((this.pausedUntil.get(provider.name) || 0) > now) return 'rate_limited';
      if (health?.lastState === 'error') return health.lastErrorCode === 'RATE_LIMITED' ? 'retry_ready' : 'unavailable';
      return health?.lastState || 'untested';
    };
    return {
      providers: this.providers.map((p) => ({
        name: p.name,
        ...(this.health.get(p.name) || {}),
        paused: [...this.pausedUntil].filter(([k, until]) => k === p.name && until > now).map(([, until]) => ({ method: 'all', until })),
        state: stateFor(p),
      })),
      cacheSize: this.cache.size,
      inflight: this.inflight.size,
      queued: this.limiter.pending,
    };
  }

  prune() {
    this.cache.prune();
    for (const [key, until] of this.pausedUntil) if (until <= Date.now()) this.pausedUntil.delete(key);
  }
}

module.exports = { XService };
