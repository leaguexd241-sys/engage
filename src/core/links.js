'use strict';

const { UserError } = require('./errors');
const { parseHandle, parseTweetUrl, intents } = require('../twitter/urls');
const { XError } = require('../twitter/errors');
const { randomCode } = require('../util/ids');

const CODE_TTL_MS = 30 * 60_000;
const MAX_ATTEMPTS = 12;

function xErrorMessage(err, handle) {
  switch (err.code) {
    case 'NOT_FOUND':
      return `No encontramos la cuenta **@${handle}** en X. Revisa que esté bien escrita.`;
    case 'PROTECTED':
      return `La cuenta **@${handle}** es privada. Hazla pública unos minutos para verificarla.`;
    case 'RATE_LIMITED':
    case 'UNAVAILABLE':
    default:
      return 'X no respondió a tiempo. Espera un minuto y vuelve a intentarlo.';
  }
}

/**
 * Vinculación de cuentas de X a usuarios de Discord.
 * Se demuestra la propiedad de la cuenta poniendo un código temporal en la biografía
 * o publicando un post con el código (se comprueba sin API, leyendo datos públicos).
 */
class LinkService {
  constructor({ store, x, bus, log }) {
    this.store = store;
    this.x = x;
    this.bus = bus;
    this.log = log;
  }

  get(userId) {
    return this.store.getLink(userId);
  }

  _assertHandleFree(handle, userId) {
    const others = this.store.getLinkByHandle(handle).filter((l) => l.userId !== userId && l.verified);
    if (others.length) {
      throw new UserError(
        `La cuenta **@${handle}** ya está vinculada y verificada por otro miembro. Si es tuya, pide ayuda a un moderador.`,
        'HANDLE_TAKEN',
      );
    }
  }

  start(user, guildId, handleInput) {
    const handle = parseHandle(handleInput);
    if (!handle) throw new UserError('Ese usuario de X no es válido. Escríbelo así: `@tuusuario` (máx. 15 caracteres, letras, números y _).', 'BAD_HANDLE');
    this._assertHandleFree(handle, user.id);
    const code = `ENG-${randomCode(6)}`;
    const request = this.store.saveLinkRequest({ userId: user.id, handle, code, guildId, ttlMs: CODE_TTL_MS });
    return {
      request,
      handle,
      code,
      tweetIntent: intents.post(`Verificando mi cuenta para Discord 🔗 ${code}`),
    };
  }

  _pending(userId) {
    const req = this.store.getLinkRequest(userId);
    if (!req) throw new UserError('No tienes ninguna vinculación pendiente. Empieza con `/vincular usuario:@tuusuario`.', 'NO_REQUEST');
    if (req.expiresAt < Date.now()) {
      this.store.deleteLinkRequest(userId);
      throw new UserError('Tu código caducó (duran 30 minutos). Usa `/vincular` otra vez para obtener uno nuevo.', 'EXPIRED');
    }
    if (req.attempts >= MAX_ATTEMPTS) {
      throw new UserError('Demasiados intentos con este código. Usa `/vincular` de nuevo para generar otro.', 'TOO_MANY');
    }
    this.store.bumpLinkAttempts(userId);
    return req;
  }

  async verifyBio(user) {
    const req = this._pending(user.id);
    let profile;
    try {
      profile = await this.x.getProfile(req.handle, { fresh: true });
    } catch (err) {
      if (err instanceof XError) throw new UserError(xErrorMessage(err, req.handle), `X_${err.code}`);
      throw err;
    }
    const haystack = `${profile.description || ''} ${profile.name || ''} ${profile.location || ''}`.toUpperCase();
    if (!haystack.includes(req.code.toUpperCase())) {
      throw new UserError(
        `No encontramos el código \`${req.code}\` en la biografía de **@${profile.handle}**.\n` +
          'Guarda los cambios de tu perfil y vuelve a pulsar el botón. X puede tardar 1-2 minutos en mostrar la biografía nueva.',
        'CODE_NOT_FOUND',
      );
    }
    return this._finalize(user, req, profile, 'bio');
  }

  async verifyTweet(user, urlInput) {
    const req = this._pending(user.id);
    const parsed = parseTweetUrl(urlInput);
    if (!parsed) throw new UserError('Ese enlace no es un post de X válido. Copia el enlace del post que publicaste con el código.', 'BAD_URL');
    let tweet;
    try {
      tweet = await this.x.getTweet(parsed.id, { fresh: true });
    } catch (err) {
      if (err instanceof XError) {
        if (err.code === 'NOT_FOUND') throw new UserError('No encontramos ese post. Asegúrate de que esté publicado y que tu cuenta sea pública.', 'X_NOT_FOUND');
        throw new UserError(xErrorMessage(err, req.handle), `X_${err.code}`);
      }
      throw err;
    }
    if (String(tweet.author.handle).toLowerCase() !== req.handle.toLowerCase()) {
      throw new UserError(`Ese post es de **@${tweet.author.handle}**, pero estás vinculando **@${req.handle}**.`, 'WRONG_AUTHOR');
    }
    if (!String(tweet.text).toUpperCase().includes(req.code.toUpperCase())) {
      throw new UserError(`El post no contiene el código \`${req.code}\`.`, 'CODE_NOT_FOUND');
    }
    let profile = null;
    try {
      profile = await this.x.getProfile(req.handle);
    } catch {
      /* no imprescindible */
    }
    return this._finalize(
      user,
      req,
      profile || { handle: tweet.author.handle, id: tweet.author.id, name: tweet.author.name, avatar: tweet.author.avatar, protected: false },
      'tweet',
    );
  }

  _finalize(user, req, profile, method) {
    const link = this.store.db.transaction(() => {
      this._assertHandleFree(profile.handle, user.id);
      const saved = this.store.saveLink({
        userId: user.id,
        handle: profile.handle,
        xId: profile.id,
        xName: profile.name,
        xAvatar: profile.avatar,
        verified: true,
        method,
        isProtected: profile.protected,
      });
      this.store.deleteLinkRequest(user.id);
      return saved;
    });
    const entry = this.store.addAudit({
      guildId: req.guildId,
      type: 'link',
      actorId: user.id,
      actorName: user.username,
      message: `${user.username} vinculó y verificó @${link.handle} (${method === 'bio' ? 'biografía' : 'post'})`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(req.guildId, 'member', { userId: user.id });
    return link;
  }

  /** Vinculación sin verificar (sólo si el servidor lo permite). */
  linkUnverified(user, guildId, handleInput) {
    const handle = parseHandle(handleInput);
    if (!handle) throw new UserError('Ese usuario de X no es válido.', 'BAD_HANDLE');
    this._assertHandleFree(handle, user.id);
    const link = this.store.saveLink({ userId: user.id, handle, verified: false, method: 'declared' });
    this.store.deleteLinkRequest(user.id);
    const entry = this.store.addAudit({
      guildId,
      type: 'link',
      actorId: user.id,
      actorName: user.username,
      message: `${user.username} vinculó @${handle} sin verificar`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(guildId, 'member', { userId: user.id });
    return link;
  }

  unlink(userId, { guildId = null, actor = null } = {}) {
    const link = this.store.getLink(userId);
    if (!link) return false;
    this.store.deleteLink(userId);
    this.store.deleteLinkRequest(userId);
    const entry = this.store.addAudit({
      guildId,
      type: 'link',
      actorId: actor?.id || userId,
      actorName: actor?.name || null,
      message: `Se desvinculó @${link.handle} del usuario ${userId}`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(guildId, 'member', { userId });
    return true;
  }

  /** Vinculación manual desde el panel (un administrador responde por ella). */
  adminLink({ userId, handleInput, verified = true, guildId = null, actor = null }) {
    const handle = parseHandle(handleInput);
    if (!handle) throw new UserError('Usuario de X no válido.', 'BAD_HANDLE');
    const link = this.store.db.transaction(() => {
      if (verified) {
        for (const other of this.store.getLinkByHandle(handle)) {
          if (other.userId !== userId && other.verified) this.store.deleteLink(other.userId);
        }
      }
      return this.store.saveLink({ userId, handle, verified, method: 'manual' });
    });
    const entry = this.store.addAudit({
      guildId,
      type: 'link',
      actorId: actor?.id || null,
      actorName: actor?.name || 'Panel',
      message: `Vinculación manual: ${userId} → @${handle}${verified ? ' (verificada)' : ''}`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(guildId, 'member', { userId });
    return link;
  }
}

module.exports = { LinkService, CODE_TTL_MS };
