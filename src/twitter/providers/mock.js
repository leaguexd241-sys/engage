'use strict';

const { XError } = require('../errors');
const { tweetUrl } = require('../urls');
const { stripLeadingMentions } = require('../../util/text');

const TWITTER_EPOCH = 1288834974657n;
const MAX_TWEETS = 5000;

/**
 * "X simulado" en memoria. Se usa en el simulador y en las pruebas automáticas
 * para reproducir cuentas, bios, respuestas y reposts sin depender de la red.
 * Para IDs/usuarios que no conoce lanza NOT_HANDLED y el servicio pasa al proveedor real.
 */
class MockX {
  constructor() {
    this.tweets = new Map();
    this.profiles = new Map();
    this.timelines = new Map();
    this.seq = 0n;
    this.deleted = new Set();
    this.maxTweets = MAX_TWEETS;
    this.failNext = null; // para simular caídas en pruebas
  }

  nextId() {
    this.seq = (this.seq + 1n) % 4096n;
    return String(((BigInt(Date.now()) - TWITTER_EPOCH) << 22n) | this.seq);
  }

  addProfile({ handle, name, description = '', avatar = null, protected: isProtected = false, followers = 10 }) {
    const p = {
      id: this.nextId(),
      handle,
      name: name || handle,
      description,
      location: '',
      avatar,
      followers,
      protected: isProtected,
    };
    this.profiles.set(handle.toLowerCase(), p);
    if (!this.timelines.has(handle.toLowerCase())) this.timelines.set(handle.toLowerCase(), []);
    return p;
  }

  getProfileSync(handle) {
    return this.profiles.get(String(handle).toLowerCase()) || null;
  }

  setBio(handle, description) {
    const p = this.getProfileSync(handle);
    if (!p) throw new Error(`Perfil simulado desconocido: ${handle}`);
    p.description = String(description).slice(0, 160);
    return p;
  }

  addTweet({ handle, text, replyTo = null, quoteOf = null, media = [], metrics = {}, createdAt = Date.now(), id = null }) {
    const profile = this.getProfileSync(handle) || this.addProfile({ handle });
    const tweetId = id || this.nextId();
    const parent = replyTo ? this.tweets.get(replyTo) : null;
    const tweet = {
      id: tweetId,
      url: tweetUrl(tweetId, profile.handle),
      author: {
        id: profile.id,
        handle: profile.handle,
        name: profile.name,
        avatar: profile.avatar,
        verified: false,
        protected: profile.protected,
      },
      text: String(text || ''),
      lang: 'es',
      createdAt,
      replyTo: replyTo ? { id: replyTo, handle: parent?.author.handle || null } : null,
      quoteOf,
      media,
      metrics: { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 100, ...metrics },
      source: 'mock',
    };
    this.tweets.set(tweetId, tweet);
    if (parent) parent.metrics.replies += 1;
    if (quoteOf && this.tweets.has(quoteOf)) this.tweets.get(quoteOf).metrics.quotes += 1;
    this._timelinePush(profile.handle, {
      id: tweetId,
      kind: replyTo ? 'reply' : quoteOf ? 'quote' : 'post',
      repostOf: null,
      replyTo,
      quoteOf,
      createdAt,
      text: tweet.text,
    });
    this._trim();
    return tweet;
  }

  like(handle, tweetId) {
    const t = this.tweets.get(tweetId);
    if (t) t.metrics.likes += 1;
    return Boolean(t);
  }

  repost(handle, tweetId) {
    const t = this.tweets.get(tweetId);
    if (t) t.metrics.reposts += 1;
    this._timelinePush(handle, {
      id: this.nextId(),
      kind: 'repost',
      repostOf: tweetId,
      replyTo: null,
      quoteOf: null,
      createdAt: Date.now(),
      text: '',
    });
    return true;
  }

  deleteTweet(id) {
    const ok = this.tweets.delete(id);
    if (ok) {
      this.deleted.add(id);
      if (this.deleted.size > this.maxTweets) this.deleted.delete(this.deleted.values().next().value);
    }
    return ok;
  }

  _timelinePush(handle, item) {
    const key = handle.toLowerCase();
    const list = this.timelines.get(key) || [];
    list.unshift(item);
    if (list.length > 100) list.length = 100;
    this.timelines.set(key, list);
  }

  _trim() {
    while (this.tweets.size > this.maxTweets) this.tweets.delete(this.tweets.keys().next().value);
  }

  _maybeFail() {
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      throw new XError(code, `Fallo simulado (${code})`);
    }
  }

  get provider() {
    const self = this;
    return {
      name: 'mock',
      async getTweet(id) {
        self._maybeFail();
        const t = self.tweets.get(String(id));
        if (!t && self.deleted.has(String(id))) throw new XError('NOT_FOUND', 'El post fue eliminado');
        if (!t) throw new XError('NOT_HANDLED');
        if (t.author.protected) throw new XError('PROTECTED', 'La cuenta es privada');
        // Igual que las fuentes reales: sin las menciones que X añade al principio de las respuestas.
        return { ...structuredClone(t), text: stripLeadingMentions(t.text) };
      },
      async getProfile(handle) {
        self._maybeFail();
        const p = self.getProfileSync(handle);
        if (!p) throw new XError('NOT_HANDLED');
        return { ...p, source: 'mock' };
      },
      async getTimeline(handle) {
        self._maybeFail();
        const p = self.getProfileSync(handle);
        if (!p) throw new XError('NOT_HANDLED');
        return {
          handle: p.handle,
          items: structuredClone(self.timelines.get(handle.toLowerCase()) || []),
          profile: { ...p },
          source: 'mock',
        };
      },
    };
  }
}

module.exports = { MockX };
