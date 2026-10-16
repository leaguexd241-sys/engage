'use strict';

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
  'twittpr.com',
  'xcancel.com',
]);

function isXHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^(?:www|mobile|m)\./, '');
  return X_HOSTS.has(h) || /^nitter\.[a-z0-9.-]+$/.test(h);
}

const RESERVED = new Set(['i', 'home', 'explore', 'search', 'settings', 'intent', 'share', 'hashtag', 'messages', 'notifications', 'compose']);

/**
 * Extrae el ID de un post a partir de un enlace de X/Twitter (o de un ID numérico).
 * @returns {{id: string, handle: string|null} | null}
 */
function parseTweetUrl(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().replace(/^<|>$/g, '');
  if (/^\d{1,20}$/.test(raw)) return { id: raw, handle: null };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!isXHost(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  // /usuario/status/123 · /i/web/status/123 · /i/status/123 · /usuario/statuses/123
  const idx = parts.findIndex((p) => p === 'status' || p === 'statuses');
  if (idx === -1 || !parts[idx + 1]) return null;
  const id = parts[idx + 1].match(/^\d{1,20}/)?.[0];
  if (!id) return null;
  // Sólo /usuario/status/123 lleva el usuario; /i/web/status/123 no.
  const maybeHandle = idx === 1 ? parts[0] : null;
  const handle = maybeHandle && HANDLE_RE.test(maybeHandle) && !RESERVED.has(maybeHandle.toLowerCase()) ? maybeHandle : null;
  return { id, handle };
}

/**
 * Normaliza un usuario de X: "@Usuario", "usuario", "https://x.com/usuario".
 * @returns {string|null} handle sin @ o null si no es válido.
 */
function parseHandle(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(s)) {
    try {
      const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      if (!isXHost(url.hostname)) return null;
      s = url.pathname.split('/').filter(Boolean)[0] || '';
    } catch {
      return null;
    }
  }
  s = s.replace(/^@+/, '');
  if (!HANDLE_RE.test(s) || RESERVED.has(s.toLowerCase())) return null;
  return s;
}

function tweetUrl(id, handle) {
  return `https://x.com/${handle || 'i'}/status/${id}`;
}

function profileUrl(handle) {
  return `https://x.com/${handle}`;
}

/** Enlaces "intent" oficiales de X: abren la acción real en la cuenta del usuario. */
const intents = {
  like: (id) => `https://x.com/intent/like?tweet_id=${encodeURIComponent(id)}`,
  repost: (id) => `https://x.com/intent/retweet?tweet_id=${encodeURIComponent(id)}`,
  reply: (id, text) =>
    `https://x.com/intent/post?in_reply_to=${encodeURIComponent(id)}${text ? `&text=${encodeURIComponent(text)}` : ''}`,
  quote: (id, handle) => `https://x.com/intent/post?url=${encodeURIComponent(tweetUrl(id, handle))}`,
  post: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
  follow: (handle) => `https://x.com/intent/follow?screen_name=${encodeURIComponent(handle)}`,
};

module.exports = { parseTweetUrl, parseHandle, tweetUrl, profileUrl, intents, isXHost, HANDLE_RE };
