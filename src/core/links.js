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
      return `Could not find the account **@${handle}** on X. Check the spelling.`;
    case 'PROTECTED':
      return `The account **@${handle}** is private. Make it public briefly to verify it.`;
    case 'RATE_LIMITED':
    case 'UNAVAILABLE':
    default:
      return 'X is temporarily unavailable. Wait a minute and try again.';
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
        `The account **@${handle}** is already linked and verified by another member. Ask a moderator for help if you own it.`,
        'HANDLE_TAKEN',
      );
    }
  }

  start(user, guildId, handleInput) {
    const handle = parseHandle(handleInput);
    if (!handle) throw new UserError('Invalid X username. Enter it like this: `@tuusuario` (up to 15 characters: letters, numbers and _).', 'BAD_HANDLE');
    this._assertHandleFree(handle, user.id);
    const code = `ENG-${randomCode(6)}`;
    const request = this.store.saveLinkRequest({ userId: user.id, handle, code, guildId, ttlMs: CODE_TTL_MS });
    return {
      request,
      handle,
      code,
      tweetIntent: intents.post(`Verifying my account for Discord 🔗 ${code}`),
    };
  }

  _pending(userId) {
    const req = this.store.getLinkRequest(userId);
    if (!req) throw new UserError('You have no pending link request. Start with `/link user:@tuusuario`.', 'NO_REQUEST');
    if (req.expiresAt < Date.now()) {
      this.store.deleteLinkRequest(userId);
      throw new UserError('Your code expired after 30 minutes. Use `/link` again to get a new one.', 'EXPIRED');
    }
    if (req.attempts >= MAX_ATTEMPTS) {
      throw new UserError('Too many attempts with this code. Use `/link` again to generate another.', 'TOO_MANY');
    }
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
    this.store.bumpLinkAttempts(user.id);
    if (!haystack.includes(req.code.toUpperCase())) {
      throw new UserError(
        `Could not find the code \`${req.code}\` in the bio of **@${profile.handle}**.\n` +
          'Save your profile and press the button again. X may take 1–2 minutes to show the updated bio.',
        'CODE_NOT_FOUND',
      );
    }
    return this._finalize(user, req, profile, 'bio');
  }

  async verifyTweet(user, urlInput) {
    const req = this._pending(user.id);
    const parsed = parseTweetUrl(urlInput);
    if (!parsed) {
      this.store.bumpLinkAttempts(user.id);
      throw new UserError('Invalid X post link. Copy the link to the post containing your code.', 'BAD_URL');
    }
    let tweet;
    try {
      tweet = await this.x.getTweet(parsed.id, { fresh: true });
    } catch (err) {
      if (err instanceof XError) {
        if (err.code === 'NOT_FOUND') throw new UserError('Could not find that post. Make sure it is published and your account is public.', 'X_NOT_FOUND');
        throw new UserError(xErrorMessage(err, req.handle), `X_${err.code}`);
      }
      throw err;
    }
    this.store.bumpLinkAttempts(user.id);
    if (String(tweet.author.handle).toLowerCase() !== req.handle.toLowerCase()) {
      throw new UserError(`That post belongs to **@${tweet.author.handle}**, but you are linking **@${req.handle}**.`, 'WRONG_AUTHOR');
    }
    if (!String(tweet.text).toUpperCase().includes(req.code.toUpperCase())) {
      throw new UserError(`The post does not contain the code \`${req.code}\`.`, 'CODE_NOT_FOUND');
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
      const current = this.store.getLinkRequest(user.id);
      if (!current || current.code !== req.code || current.expiresAt <= Date.now()) throw new UserError('Your link request expired or changed. Start again with /link.', 'EXPIRED');
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
      message: `${user.username} linked and verified @${link.handle} (${method === 'bio' ? 'bio' : 'post'})`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(req.guildId, 'member', { userId: user.id });
    return link;
  }

  /** Vinculación sin verificar (sólo si el servidor lo permite). */
  linkUnverified(user, guildId, handleInput) {
    const handle = parseHandle(handleInput);
    if (!handle) throw new UserError('Invalid X username.', 'BAD_HANDLE');
    this._assertHandleFree(handle, user.id);
    const link = this.store.saveLink({ userId: user.id, handle, verified: false, method: 'declared' });
    this.store.deleteLinkRequest(user.id);
    const entry = this.store.addAudit({
      guildId,
      type: 'link',
      actorId: user.id,
      actorName: user.username,
      message: `${user.username} linked @${handle} unverified`,
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
      message: `Unlinked @${link.handle} from user ${userId}`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(guildId, 'member', { userId });
    return true;
  }

  /** Vinculación manual desde el panel (un administrador responde por ella). */
  adminLink({ userId, handleInput, verified = true, guildId = null, actor = null }) {
    const handle = parseHandle(handleInput);
    if (!handle) throw new UserError('Invalid X username.', 'BAD_HANDLE');
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
      message: `Manual link: ${userId} → @${handle}${verified ? ' (verified)' : ''}`,
    });
    this.bus?.emit('audit', entry);
    this.bus?.change(guildId, 'member', { userId });
    return link;
  }
}

module.exports = { LinkService, CODE_TTL_MS };
