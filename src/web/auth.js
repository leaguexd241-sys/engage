'use strict';

const crypto = require('node:crypto');
const { WindowLimiter } = require('../util/ratelimit');

const COOKIE = 'eng_session';
const OAUTH_COOKIE = 'eng_oauth';
const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

function b64(s) {
  return Buffer.from(s).toString('base64url');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[k] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Sesiones firmadas con HMAC guardadas en una cookie (sin estado en el servidor → sin memoria que crezca).
 */
class Auth {
  constructor({ config, store, log }) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.secret = config.web.sessionSecret;
    this.loginLimiter = new WindowLimiter({ windowMs: 10 * 60_000, max: 8 });
    this.maxAgeMs = config.web.sessionHours * 3600_000;
  }

  get oauthEnabled() {
    return Boolean(this.config.discord.clientId && this.config.discord.clientSecret);
  }

  get version() {
    return this.store.kvGet('session_version') || '1';
  }

  revokeAll() {
    this.store.kvSet('session_version', String(Number(this.version) + 1));
  }

  sign(data) {
    const body = b64(JSON.stringify(data));
    const mac = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify(token) {
    if (!token || typeof token !== 'string' || token.length > 8000) return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    try {
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!data.exp || data.exp < Date.now()) return null;
      if (data.v !== this.version) return null;
      return data;
    } catch {
      return null;
    }
  }

  cookieOptions(maxAgeMs) {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (this.config.web.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  setSession(res, session) {
    const data = { ...session, exp: Date.now() + this.maxAgeMs, v: this.version };
    res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(this.sign(data))}; ${this.cookieOptions(this.maxAgeMs)}`);
  }

  clearSession(res) {
    res.append('Set-Cookie', `${COOKIE}=; ${this.cookieOptions(0)}`);
  }

  /** Middleware: lee la sesión (si existe) y la deja en req.session. */
  middleware() {
    return (req, _res, next) => {
      const cookies = parseCookies(req.headers.cookie);
      req.cookies = cookies;
      req.session = this.verify(cookies[COOKIE]);
      next();
    };
  }

  requireAuth() {
    return (req, res, next) => {
      if (!req.session) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
      return next();
    };
  }

  canAccessGuild(session, guildId) {
    if (!session) return false;
    if (session.owner) return true;
    return Array.isArray(session.guilds) && session.guilds.includes(guildId);
  }

  // ─── Contraseña ────────────────────────────────────────────────
  passwordLogin(req, res) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!this.loginLimiter.check(ip)) {
      const wait = Math.ceil(this.loginLimiter.retryAfter(ip) / 60000);
      return res.status(429).json({ error: `Demasiados intentos. Espera ${wait} min.` });
    }
    const password = String(req.body?.password || '');
    if (!password || !safeEqual(password, this.config.web.password)) {
      this.log.warn(`Intento de acceso fallido al panel desde ${ip}`);
      return res.status(401).json({ error: 'Contraseña incorrecta.' });
    }
    this.loginLimiter.reset(ip);
    this.setSession(res, { uid: 'owner', name: 'Administrador', avatar: null, owner: true, method: 'password' });
    this.log.info(`Acceso al panel con contraseña desde ${ip}`);
    return res.json({ ok: true });
  }

  // ─── Discord OAuth2 ────────────────────────────────────────────
  redirectUri() {
    return `${this.config.web.publicUrl}/auth/discord/callback`;
  }

  oauthStart(req, res) {
    if (!this.oauthEnabled) return res.redirect('/#/login?error=oauth-off');
    const state = crypto.randomBytes(18).toString('base64url');
    res.append('Set-Cookie', `${OAUTH_COOKIE}=${state}; ${this.cookieOptions(10 * 60_000)}`);
    const params = new URLSearchParams({
      client_id: this.config.discord.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: 'identify guilds',
      state,
    });
    return res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  }

  async oauthCallback(req, res, { botGuildIds, fetchImpl = fetch }) {
    const fail = (code) => {
      res.append('Set-Cookie', `${OAUTH_COOKIE}=; ${this.cookieOptions(0)}`);
      return res.redirect(`/#/login?error=${code}`);
    };
    const { code, state } = req.query;
    const expected = req.cookies?.[OAUTH_COOKIE];
    if (!code || !state || !expected || !safeEqual(String(state), expected)) return fail('state');
    const api = this.config.discord.apiBase;
    try {
      const tokenRes = await fetchImpl(`${api}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.discord.clientId,
          client_secret: this.config.discord.clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: this.redirectUri(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenRes.ok) return fail('token');
      const token = await tokenRes.json();
      const auth = { authorization: `${token.token_type || 'Bearer'} ${token.access_token}` };
      const [meRes, guildsRes] = await Promise.all([
        fetchImpl(`${api}/users/@me`, { headers: auth, signal: AbortSignal.timeout(15_000) }),
        fetchImpl(`${api}/users/@me/guilds`, { headers: auth, signal: AbortSignal.timeout(15_000) }),
      ]);
      if (!meRes.ok || !guildsRes.ok) return fail('discord');
      const me = await meRes.json();
      const guilds = await guildsRes.json();
      const owner = this.config.discord.ownerIds.includes(me.id);
      const bot = new Set(botGuildIds);
      const manageable = (Array.isArray(guilds) ? guilds : [])
        .filter((g) => {
          const perms = BigInt(g.permissions || 0);
          return g.owner || (perms & MANAGE_GUILD) === MANAGE_GUILD || (perms & ADMINISTRATOR) === ADMINISTRATOR;
        })
        .map((g) => g.id)
        .filter((id) => bot.has(id));
      if (!owner && manageable.length === 0) return fail('noguilds');
      const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null;
      res.append('Set-Cookie', `${OAUTH_COOKIE}=; ${this.cookieOptions(0)}`);
      this.setSession(res, { uid: me.id, name: me.global_name || me.username, avatar, owner, guilds: owner ? undefined : manageable, method: 'discord' });
      this.log.info(`Acceso al panel con Discord: ${me.username} (${me.id})`);
      return res.redirect('/#/');
    } catch (err) {
      this.log.warn(`OAuth2 de Discord falló: ${err.message}`);
      return fail('discord');
    }
  }
}

module.exports = { Auth, parseCookies, safeEqual, COOKIE };
