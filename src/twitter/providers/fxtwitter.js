'use strict';

const { XError } = require('../errors');
const { httpGet, parseJson } = require('../http');
const { stripLeadingMentions } = require('../../util/text');
const { tweetUrl } = require('../urls');

const BASE = 'https://api.fxtwitter.com';

function num(v) {
  return Number.isFinite(v) ? v : null;
}

function bigAvatar(url) {
  return url ? String(url).replace('_normal.', '_200x200.') : null;
}

function normalizeTweet(s) {
  const author = s.author || {};
  let replyTo = null;
  if (s.replying_to && typeof s.replying_to === 'object' && s.replying_to.status) {
    replyTo = { id: String(s.replying_to.status), handle: s.replying_to.screen_name || null };
  } else if (s.replying_to_status) {
    replyTo = { id: String(s.replying_to_status), handle: typeof s.replying_to === 'string' ? s.replying_to : null };
  }
  const media = (s.media?.all || []).map((m) => ({
    type: m.type === 'gif' ? 'gif' : m.type === 'video' ? 'video' : 'photo',
    url: m.type === 'photo' ? String(m.url || '').replace(/\?name=orig$/, '') : m.thumbnail_url || m.url,
  }));
  return {
    id: String(s.id),
    url: tweetUrl(s.id, author.screen_name),
    author: {
      id: author.id ? String(author.id) : null,
      handle: author.screen_name || null,
      name: author.name || author.screen_name || null,
      avatar: bigAvatar(author.avatar_url),
      verified: Boolean(author.verification?.verified),
      protected: Boolean(author.protected),
    },
    text: stripLeadingMentions(s.text ?? s.raw_text?.text ?? '').trim(),
    lang: s.lang || null,
    createdAt: s.created_timestamp ? s.created_timestamp * 1000 : s.created_at ? Date.parse(s.created_at) : null,
    replyTo,
    quoteOf: s.quote?.id ? String(s.quote.id) : null,
    media,
    metrics: {
      likes: num(s.likes),
      replies: num(s.replies),
      reposts: num(s.reposts ?? s.retweets),
      quotes: num(s.quotes),
      views: num(s.views),
    },
    source: 'fxtwitter',
  };
}

function classify(res, j, what) {
  const code = j?.code ?? res.status;
  if (code === 404) throw new XError('NOT_FOUND', `${what} no existe o fue eliminado`);
  if (code === 401 || code === 403) throw new XError('PROTECTED', 'La cuenta es privada');
  if (code === 429) throw new XError('RATE_LIMITED', 'Límite de peticiones');
  if (code === 400) throw new XError('NOT_FOUND', `${what} no válido`);
  if (code >= 400 || res.status >= 400) throw new XError('UNAVAILABLE', `HTTP ${code}`);
}

function createFxTwitterProvider({ timeoutMs, userAgent, fetchImpl } = {}) {
  const opts = { timeoutMs, userAgent, fetchImpl, accept: 'application/json' };

  async function getTweet(id) {
    const res = await httpGet(`${BASE}/2/status/${id}`, opts);
    const j = parseJson(res.text);
    if (!j) {
      if (res.status === 404) throw new XError('NOT_FOUND', 'El post no existe o fue eliminado');
      throw new XError('UNAVAILABLE', `Respuesta no válida (HTTP ${res.status})`);
    }
    classify(res, j, 'El post');
    if (!j.status?.id) throw new XError('UNAVAILABLE', 'Formato inesperado');
    return normalizeTweet(j.status);
  }

  async function getProfile(handle) {
    const res = await httpGet(`${BASE}/2/profile/${encodeURIComponent(handle)}`, opts);
    const j = parseJson(res.text);
    if (!j) {
      if (res.status === 404 || res.status === 302) throw new XError('NOT_FOUND', 'Usuario no encontrado');
      throw new XError('UNAVAILABLE', `Respuesta no válida (HTTP ${res.status})`);
    }
    classify(res, j, 'El usuario');
    const u = j.user;
    if (!u?.screen_name) throw new XError('UNAVAILABLE', 'Formato inesperado');
    return {
      id: u.id ? String(u.id) : null,
      handle: u.screen_name,
      name: u.name || u.screen_name,
      description: u.raw_description?.text ?? u.description ?? '',
      location: u.location || '',
      avatar: bigAvatar(u.avatar_url),
      followers: num(u.followers),
      protected: Boolean(u.protected),
      source: 'fxtwitter',
    };
  }

  return { name: 'fxtwitter', getTweet, getProfile };
}

module.exports = { createFxTwitterProvider, normalizeTweet };
