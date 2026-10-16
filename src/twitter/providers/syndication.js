'use strict';

const { XError } = require('../errors');
const { httpGet, parseJson, retryAfterMs } = require('../http');
const { stripLeadingMentions } = require('../../util/text');
const { tweetUrl } = require('../urls');

const ENTITY_MAP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const decodeEntities = (s) => String(s || '').replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => ENTITY_MAP[m]);

/** Token que exige el endpoint de embeds de X (mismo cálculo que usa su widget). */
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function bigAvatar(url) {
  return url ? String(url).replace('_normal.', '_200x200.') : null;
}

function normalizeTweet(j) {
  const chars = Array.from(String(j.text || ''));
  const range = Array.isArray(j.display_text_range) ? j.display_text_range : [0, chars.length];
  let text = chars.slice(range[0], range[1]).join('');
  for (const u of j.entities?.urls || []) {
    if (u.url && (u.display_url || u.expanded_url)) text = text.split(u.url).join(u.display_url || u.expanded_url);
  }
  text = stripLeadingMentions(decodeEntities(text)).trim();
  const media = (j.mediaDetails || []).map((m) => ({
    type: m.type === 'animated_gif' ? 'gif' : m.type === 'video' ? 'video' : 'photo',
    url: m.media_url_https,
  }));
  const handle = j.user?.screen_name || null;
  return {
    id: j.id_str,
    url: tweetUrl(j.id_str, handle),
    author: {
      id: j.user?.id_str || null,
      handle,
      name: j.user?.name || handle,
      avatar: bigAvatar(j.user?.profile_image_url_https),
      verified: Boolean(j.user?.is_blue_verified || j.user?.verified),
      protected: false,
    },
    text,
    lang: j.lang || null,
    createdAt: j.created_at ? Date.parse(j.created_at) : null,
    replyTo: j.in_reply_to_status_id_str
      ? { id: j.in_reply_to_status_id_str, handle: j.in_reply_to_screen_name || null }
      : null,
    quoteOf: j.quoted_tweet?.id_str || null,
    media,
    metrics: {
      likes: Number.isFinite(j.favorite_count) ? j.favorite_count : null,
      replies: Number.isFinite(j.conversation_count) ? j.conversation_count : null,
      reposts: Number.isFinite(j.retweet_count) ? j.retweet_count : null,
      quotes: Number.isFinite(j.quote_count) ? j.quote_count : null,
      views: null,
    },
    source: 'syndication',
  };
}

function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  return parseJson(m[1]);
}

function normalizeTimelineTweet(tw) {
  const kind = tw.retweeted_status ? 'repost' : tw.quoted_status_id_str || tw.quoted_status ? 'quote' : tw.in_reply_to_status_id_str ? 'reply' : 'post';
  return {
    id: tw.id_str,
    kind,
    repostOf: tw.retweeted_status?.id_str || null,
    replyTo: tw.in_reply_to_status_id_str || null,
    quoteOf: tw.quoted_status_id_str || tw.quoted_status?.id_str || null,
    createdAt: tw.created_at ? Date.parse(tw.created_at) : null,
    text: decodeEntities(tw.full_text || tw.text || '').slice(0, 500),
  };
}

function createSyndicationProvider({ timeoutMs, userAgent, fetchImpl } = {}) {
  const opts = { timeoutMs, userAgent, fetchImpl };

  async function getTweet(id) {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=es`;
    const res = await httpGet(url, opts);
    if (res.status === 404) throw new XError('NOT_FOUND', 'El post no existe o fue eliminado');
    if (res.status === 429) throw new XError('RATE_LIMITED', 'Límite de peticiones de X', { retryAfterMs: retryAfterMs(res.headers) });
    if (res.status >= 400) throw new XError('UNAVAILABLE', `HTTP ${res.status}`);
    if (!res.text.trim()) throw new XError('UNAVAILABLE', 'X devolvió una respuesta vacía');
    const j = parseJson(res.text);
    if (!j) throw new XError('UNAVAILABLE', 'Respuesta no válida');
    if (j.__typename === 'TweetTombstone') {
      const reason = String(j.tombstone?.text?.text || '');
      if (/limits who can view|protected|protegid/i.test(reason)) throw new XError('PROTECTED', 'La cuenta es privada');
      throw new XError('NOT_FOUND', 'El post no está disponible');
    }
    if (!j.id_str) throw new XError('UNAVAILABLE', 'X no devolvió los datos del post');
    return normalizeTweet(j);
  }

  async function getTimeline(handle) {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
    const res = await httpGet(url, { ...opts, accept: 'text/html' });
    if (res.status === 404) throw new XError('NOT_FOUND', 'Usuario no encontrado');
    if (res.status === 429) throw new XError('RATE_LIMITED', 'Límite de peticiones de X', { retryAfterMs: retryAfterMs(res.headers) });
    if (res.status >= 400) throw new XError('UNAVAILABLE', `HTTP ${res.status}`);
    const data = parseNextData(res.text);
    const timeline = data?.props?.pageProps?.timeline;
    if (!timeline) throw new XError('UNAVAILABLE', 'Formato de timeline inesperado');
    const tweets = (timeline.entries || []).map((e) => e?.content?.tweet).filter(Boolean);
    const lc = handle.toLowerCase();
    const own = tweets.find((t) => t.user?.screen_name?.toLowerCase() === lc);
    const profile = own
      ? {
          id: own.user.id_str,
          handle: own.user.screen_name,
          name: own.user.name,
          description: own.user.description || '',
          location: own.user.location || '',
          avatar: bigAvatar(own.user.profile_image_url_https),
          followers: own.user.followers_count ?? null,
          protected: Boolean(own.user.protected),
        }
      : null;
    return {
      handle,
      items: tweets.map(normalizeTimelineTweet),
      profile,
      source: 'syndication',
    };
  }

  async function getProfile(handle) {
    const tl = await getTimeline(handle);
    if (!tl.profile) throw new XError('NOT_FOUND', 'No se pudo leer el perfil');
    return { ...tl.profile, source: 'syndication' };
  }

  return { name: 'syndication', getTweet, getProfile, getTimeline };
}

module.exports = { createSyndicationProvider, syndicationToken, normalizeTweet, decodeEntities };
