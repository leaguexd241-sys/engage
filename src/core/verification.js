'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { UserError } = require('./errors');
const { ACTION_INFO } = require('./settings');
const { analyzeReply } = require('./quality');
const { findDuplicate } = require('./similarity');
const { applyTrust } = require('./trust');
const { parseTweetUrl } = require('../twitter/urls');
const { XError } = require('../twitter/errors');
const { KeyedLock } = require('../util/ratelimit');

const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const PROOF_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Comprueba la "firma" binaria del archivo (PNG, JPG, GIF, WEBP). */
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const gif = buf.subarray(0, 4).toString('ascii') === 'GIF8';
  const webp = buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpg || gif || webp;
}

function isUniqueEvidenceError(err) {
  return /UNIQUE constraint failed: submissions\.evidence_id/i.test(String(err?.message));
}

/**
 * Verificación de participaciones.
 *  - Comentarios y citas: se leen de X y se comprueba autor, destino, calidad y copias.
 *  - Reposts: se buscan en el perfil público del usuario; si no aparecen, se aplica el modo de prueba del servidor.
 *  - Likes: X los hizo privados en 2024, así que se aplican declaración, captura o revisión según la configuración.
 */
class VerificationService {
  constructor({ store, x, tasks, bus, log, proofsDir }) {
    this.store = store;
    this.x = x;
    this.tasks = tasks;
    this.bus = bus;
    this.log = log;
    this.lock = new KeyedLock();
    this.background = new Set();
    this.proofsDir = proofsDir;
    if (proofsDir) fs.mkdirSync(proofsDir, { recursive: true });
  }

  _fresh(taskRef) {
    const task = this.store.getTask(taskRef.id);
    if (!task) throw new UserError('That task no longer exists.', 'NOT_FOUND');
    return task;
  }

  /** Qué enlaces hay que pedirle al usuario (comentario y/o cita) para esta tarea. */
  neededInputs(task, userId) {
    const subs = new Map(this.store.userSubmissions(task.id, userId).map((s) => [s.action, s]));
    return ['reply', 'quote'].filter((a) => {
      if (!task.actions.includes(a)) return false;
      const s = subs.get(a);
      return !s || s.status === 'rejected' || s.status === 'revoked';
    });
  }

  _checkAccess(task, user, settings) {
    if (!this.tasks.isOpen(task)) throw new UserError(`Task #${task.id} has ended. Watch for the next one!`, 'CLOSED');
    const member = this.store.touchMember(task.guildId, user);
    if (member.blacklisted) throw new UserError('You cannot participate in this server. Contact staff if you believe this is a mistake.', 'BLACKLISTED');
    const link = this.store.getLink(user.id);
    const v = settings.verification;
    if (v.requireLink && !link) {
      throw new UserError('First link your X account with `/link user:@tuusuario`. You only need to do this once.', 'NO_LINK');
    }
    if (v.requireLink && v.requireVerifiedLink && link && !link.verified) {
      throw new UserError('Your X account is linked but unverified. Use `/link` to verify it with your code.', 'LINK_UNVERIFIED');
    }
    return { member, link };
  }

  /**
   * Verifica todas las acciones pendientes de un usuario en una tarea.
   * @param {{task:object, user:{id:string,username:string,displayName?:string,avatar?:string}, inputs?:{reply?:string, quote?:string}}} p
   */
  async verify({ task: taskRef, user, inputs = {} }) {
    // Siempre con el estado actual de la base de datos (el formulario pudo abrirse antes de cerrar la tarea).
    const task = this._fresh(taskRef);
    const key = `${task.id}:${user.id}`;
    const res = await this.lock.run(key, () => this._verify(task, user, inputs));
    if (res.busy) throw new UserError('Your participation is already being checked. Please wait a few seconds.', 'BUSY');
    return res.value;
  }

  async _verify(task, user, inputs) {
    const settings = this.store.getSettings(task.guildId);
    const v = settings.verification;
    const { member, link } = this._checkAccess(task, user, settings);
    const existing = new Map(this.store.userSubmissions(task.id, user.id).map((s) => [s.action, s]));
    const results = [];
    const writes = [];
    const trustEvents = [];

    for (const action of task.actions) {
      const prev = existing.get(action);
      if (prev?.status === 'verified') {
        results.push({ action, state: 'already', ok: true, message: 'Already verified.' });
        continue;
      }
      if (prev?.status === 'pending' && !(prev.details?.qualityReview && inputs[action])) {
        results.push({ action, state: 'pending', ok: false, message: 'Awaiting staff review.' });
        continue;
      }
      if (prev && (prev.status === 'rejected' || prev.status === 'revoked') && prev.attempts >= v.maxAttempts) {
        results.push({ action, state: 'rejected', ok: false, message: `You have used all ${v.maxAttempts} attempts for this action. Please ask staff for help.` });
        continue;
      }

      if (action === 'reply' || action === 'quote') {
        const r = await this._checkPost(task, user, link, action, inputs[action], settings);
        if (prev?.status === 'pending' && prev.details?.qualityReview) {
          if (r.write?.status === 'rejected') {
            r.result = { action, state: 'pending', ok: false, message: `${r.result.message} Your earlier submission remains in staff review. No attempt was deducted.` };
            r.write = r.trust = null;
          } else if (r.write?.status === 'pending' && r.write.evidenceId === prev.evidenceId && r.write.evidenceText === prev.evidenceText) {
            r.write = null;
          }
        }
        results.push(r.result);
        if (r.write) writes.push(r.write);
        if (r.trust) trustEvents.push(r.trust);
        continue;
      }

      // like / repost
      if (action === 'repost' && v.repostTimelineCheck && link) {
        const found = await this.x.findInTimeline(link.handle, task.tweetId, 'repost', { fresh: true });
        if (found.found) {
          writes.push({ action, status: 'verified', method: 'timeline', evidenceId: found.item.id, evidenceUrl: null, details: { timelineId: found.item.id } });
          trustEvents.push('auto_verified');
          results.push({ action, state: 'verified', ok: true, method: 'timeline', message: 'Repost found on your public X profile.' });
          continue;
        }
      }
      const trusted = member.trust >= v.autoApproveTrust;
      if (v.proofMode === 'declared' || trusted) {
        writes.push({ action, status: 'verified', method: 'declared', details: { trustedAuto: v.proofMode !== 'declared' } });
        results.push({
          action,
          state: 'verified',
          ok: true,
          method: 'declared',
          message: v.proofMode === 'declared' ? 'Recorded.' : 'Approved automatically based on your trust level.',
        });
      } else if (v.proofMode === 'screenshot') {
        if (prev?.status !== 'awaiting') writes.push({ action, status: 'awaiting', method: 'screenshot', countAttempt: false });
        results.push({ action, state: 'awaiting', ok: false, message: `Upload a screenshot with \`/proof task:${task.id} action:${action}\`.` });
      } else {
        writes.push({ action, status: 'pending', method: 'declared', countAttempt: false });
        results.push({ action, state: 'pending', ok: false, message: 'Sent to staff for review.' });
      }
    }

    let sync = null;
    let reviewSubs = [];
    try {
      sync = this.store.db.transaction(() => {
        this._checkAccess(this._fresh(task), user, settings);
        const saved = [];
        for (const w of writes) {
          saved.push(
            this.store.upsertSubmission({
              taskId: task.id,
              guildId: task.guildId,
              userId: user.id,
              ...w,
            }),
          );
        }
        reviewSubs = saved.filter((s) => s.status === 'pending');
        for (const ev of trustEvents) this.store.adjustTrust(task.guildId, user.id, (t) => applyTrust(t, ev));
        const rejections = writes.filter((w) => w.status === 'rejected').length;
        if (rejections) this.store.incMember(task.guildId, user.id, 'rejected', rejections);
        return this.tasks.syncUserTask(task, user.id);
      });
    } catch (err) {
      if (isUniqueEvidenceError(err)) {
        throw new UserError('That post has already been used as evidence for another submission.', 'EVIDENCE_USED');
      }
      throw err;
    }

    this.tasks.markDirty(task.id);
    this.bus?.change(task.guildId, 'submission', { taskId: task.id, userId: user.id });
    const name = user.displayName || user.username;
    if (sync.completedNow) {
      this.tasks.audit(task.guildId, 'complete', { id: user.id, name }, `${name} completed task #${task.id}`, { taskId: task.id, userId: user.id });
    }
    for (const r of results.filter((x) => x.state === 'rejected' && x.fresh)) {
      this.tasks.audit(task.guildId, 'reject', { id: user.id, name }, `${name}: ${ACTION_INFO[r.action].label.toLowerCase()} rejected on #${task.id} — ${r.reason || r.message}`, {
        taskId: task.id,
        userId: user.id,
      });
    }
    for (const s of reviewSubs) {
      this.publishReview(task, s, user).catch((err) => this.log?.warn(`Aviso de revisión falló: ${err.message}`));
    }
    return { results, progress: sync.progress, completedNow: sync.completedNow, task };
  }

  /** Comprueba un comentario o una cita a partir del enlace que pega el usuario. */
  async _checkPost(task, user, link, action, urlInput, settings) {
    const v = settings.verification;
    const label = action === 'reply' ? 'reply' : 'quote';
    if (!urlInput || !String(urlInput).trim()) {
      return { result: { action, state: 'missing', ok: false, message: `Paste the link to your ${label} to verify it.` } };
    }
    const parsed = parseTweetUrl(urlInput);
    const reject = (reason, trust = null, extra = {}) => ({
      result: { action, state: 'rejected', ok: false, fresh: true, reason, message: reason },
      write: { action, status: 'rejected', method: 'auto', evidenceUrl: String(urlInput).slice(0, 300), reason, ...extra },
      trust,
    });
    if (!parsed) return reject(`The link to your ${label} is not a valid X post.`);
    if (parsed.id === task.tweetId) return reject(`That is the task post link. Please provide the link to YOUR ${label}.`);

    let post;
    try {
      post = await this.x.getTweet(parsed.id, { fresh: true });
    } catch (err) {
      if (err instanceof XError) {
        if (err.code === 'NOT_FOUND') return reject(`We could not find your ${label}. Is it published? If you just posted it, wait a few seconds.`);
        if (err.code === 'PROTECTED') return reject('Your X account is private. Make it public so your interactions can be verified.');
        return {
          result: { action, state: 'error', ok: false, message: 'X is temporarily unavailable. Try ✅ again later. No attempts were deducted.' },
        };
      }
      throw err;
    }

    const author = String(post.author.handle || '').toLowerCase();
    if (link && author !== link.handle.toLowerCase()) {
      return reject(`That ${label} belongs to @${post.author.handle}, but your linked account is @${link.handle}.`, 'wrong_account');
    }

    if (action === 'reply') {
      let ok = post.replyTo?.id === task.tweetId;
      if (!ok && v.allowThreadReplies && post.replyTo?.id) ok = await this._inThread(post.replyTo.id, task.tweetId);
      if (!ok) return reject('That post is not a reply to the task post. Reply directly to the original post.');
    } else if (post.quoteOf !== task.tweetId) {
      return reject('That post does not quote the task post. Use the Quote button on X.');
    }

    const q = analyzeReply(post.text, { tweetText: task.tweet?.text || '' });
    const details = { quality: q, author: post.author.handle, authorChecked: Boolean(link) };
    // A heuristic cannot decide whether a real contribution is valuable. Keep the
    // evidence for a human review without spending attempts or reducing trust.
    if (q.score < v.minReplyQuality) {
      return {
        result: { action, state: 'pending', ok: false, quality: q.score, message: 'Your post was verified on X and sent to staff for a quality review. No points, trust or attempts were deducted. You can submit a revised post with /verify.' },
        write: { action, status: 'pending', method: 'auto', evidenceUrl: post.url, evidenceId: post.id, evidenceText: post.text.slice(0, 1000), quality: q.score, countAttempt: false, details: { ...details, qualityReview: true, threshold: v.minReplyQuality } },
      };
    }

    if (v.antiDuplicate) {
      const candidates = [
        ...this.store.replyTextsForTask(task.id, user.id),
        ...this.store.recentUserReplies(task.guildId, user.id, task.id),
      ];
      const dup = findDuplicate(post.text, candidates, v.duplicateThreshold);
      if (dup) {
        const why = dup.own ? 'It is almost identical to one of your previous replies' : 'It is almost identical to another member reply';
        return reject(`${why} (${Math.round(dup.similarity * 100)}% similarity). Write an original reply.`, 'duplicate', {
          evidenceText: post.text.slice(0, 1000),
          quality: q.score,
          details: { ...details, duplicateOf: dup.userId, similarity: dup.similarity },
        });
      }
    }

    return {
      result: { action, state: 'verified', ok: true, method: 'auto', quality: q.score, grade: q.grade.label, message: `Verified ✓ Quality ${q.score}/100 (${q.grade.label}).` },
      write: {
        action,
        status: 'verified',
        method: 'auto',
        evidenceUrl: post.url,
        evidenceId: post.id,
        evidenceText: post.text.slice(0, 1000),
        quality: q.score,
        details,
      },
      trust: 'auto_verified',
    };
  }

  /** ¿La respuesta está dentro del hilo del post? (sube hasta 3 niveles) */
  async _inThread(parentId, targetId) {
    let current = parentId;
    for (let i = 0; i < 3 && current; i++) {
      if (current === targetId) return true;
      try {
        const t = await this.x.getTweet(current);
        current = t.replyTo?.id || null;
      } catch {
        return false;
      }
    }
    return current === targetId;
  }

  // ─── Capturas de pantalla ──────────────────────────────────────
  async _storeProof({ buffer: data, contentType }) {
    const ext = PROOF_TYPES[String(contentType || '').split(';')[0].trim().toLowerCase()];
    if (!ext) throw new UserError('Evidence must be an image (PNG, JPG, WEBP or GIF).', 'BAD_PROOF');
    if (!data || !data.length) throw new UserError('The image is empty.', 'BAD_PROOF');
    if (!looksLikeImage(data)) throw new UserError('The file does not appear to be a valid image.', 'BAD_PROOF');
    if (data.length > MAX_PROOF_BYTES) throw new UserError('The image exceeds 8 MB.', 'BAD_PROOF');
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    await fs.promises.writeFile(path.join(this.proofsDir, name), data);
    return `proof:${name}`;
  }

  async _downloadImage(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new UserError('Could not download the image. Try again.', 'PROOF_DOWNLOAD');
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try { for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROOF_BYTES) {
        await reader.cancel().catch(() => {});
        throw new UserError('The image exceeds 8 MB.', 'BAD_PROOF');
      }
      chunks.push(Buffer.from(value));
    } } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }

  /**
   * Guarda una captura como prueba de like/repost.
   * @param {{task, user, action, attachment:{url?:string, buffer?:Buffer, contentType:string, size?:number}}} p
   */
  async submitProof(input) {
    const result = await this.lock.run(`${input.task.id}:${input.user.id}`, () => this._submitProof(input));
    if (result.busy) throw new UserError('Your participation is already being checked. Please wait a few seconds.', 'BUSY');
    return result.value;
  }

  async _submitProof({ task: taskRef, user, action, attachment }) {
    const task = this._fresh(taskRef);
    if (!['like', 'repost'].includes(action)) throw new UserError('Screenshots are only accepted for likes or reposts. Replies and quotes use their post link.', 'BAD_ACTION');
    if (!task.actions.includes(action)) throw new UserError(`Task #${task.id} does not require a ${ACTION_INFO[action].label.toLowerCase()}.`, 'BAD_ACTION');
    const settings = this.store.getSettings(task.guildId);
    const { member } = this._checkAccess(task, user, settings);
    if (attachment.size && attachment.size > MAX_PROOF_BYTES) throw new UserError('The image exceeds 8 MB.', 'BAD_PROOF');
    if (!PROOF_TYPES[String(attachment.contentType || '').split(';')[0].trim().toLowerCase()]) {
      throw new UserError('Evidence must be an image (PNG, JPG, WEBP or GIF).', 'BAD_PROOF');
    }
    const prev = this.store.userSubmissions(task.id, user.id).find((s) => s.action === action);
    if (prev?.status === 'verified') throw new UserError('That action is already verified. No screenshot is needed.', 'ALREADY');

    const buffer = attachment.buffer || (await this._downloadImage(attachment.url));
    this._checkAccess(this._fresh(task), user, settings);
    const evidence = await this._storeProof({ buffer, contentType: attachment.contentType });

    const auto = member.trust >= settings.verification.autoApproveTrust;
    let savedResult;
    try { savedResult = this.store.db.transaction(() => {
      this._checkAccess(this._fresh(task), user, settings);
      const saved = this.store.upsertSubmission({
        taskId: task.id,
        guildId: task.guildId,
        userId: user.id,
        action,
        status: auto ? 'verified' : 'pending',
        method: 'screenshot',
        evidenceUrl: evidence,
        details: { originalUrl: attachment.url || null, autoApproved: auto },
        countAttempt: false,
      });
      if (auto) this.store.adjustTrust(task.guildId, user.id, (t) => applyTrust(t, 'screenshot_approved'));
      return { sub: saved, sync: this.tasks.syncUserTask(task, user.id) };
    }); } catch (err) {
      await fs.promises.unlink(this.proofPath(evidence)).catch(() => {});
      throw err;
    }
    const { sub, sync } = savedResult;
    this.tasks.markDirty(task.id);
    this.bus?.change(task.guildId, 'submission', { taskId: task.id, userId: user.id });
    const name = user.displayName || user.username;
    this.tasks.audit(task.guildId, 'proof', { id: user.id, name }, `${name} uploaded a screenshot (${ACTION_INFO[action].label}) on #${task.id}${auto ? ' — automatically approved' : ''}`, {
      taskId: task.id,
      userId: user.id,
    });
    if (sync.completedNow) this.tasks.audit(task.guildId, 'complete', { id: user.id, name }, `${name} completed task #${task.id}`, { taskId: task.id, userId: user.id });
    if (!auto) this.publishReview(task, sub, user, attachment.url).catch((err) => this.log?.warn(`Aviso de revisión falló: ${err.message}`));
    return { submission: sub, autoApproved: auto, progress: sync.progress };
  }

  proofPath(evidence) {
    if (!evidence || !String(evidence).startsWith('proof:')) return null;
    const name = String(evidence).slice(6);
    if (!/^[\w][\w.-]*$/.test(name) || name.includes('..') || !this.proofsDir) return null;
    return path.join(this.proofsDir, name);
  }

  publishReview(task, sub, user, imageUrl = null) {
    const job = this._publishReview(task, sub, user, imageUrl).finally(() => this.background.delete(job));
    this.background.add(job);
    return job;
  }

  idle() {
    return Promise.allSettled([...this.background]);
  }

  async _publishReview(task, sub, user, imageUrl = null) {
    const link = this.store.getLink(sub.userId);
    const posted = await this.tasks.publisher.reviewRequest(task, sub, { ...user, xHandle: link?.handle || null }, imageUrl);
    if (posted?.messageId) {
      this.store.mergeSubmissionDetails(sub.id, { reviewMessage: { channelId: posted.channelId, messageId: posted.messageId, imageUrl: imageUrl || null } });
    }
  }

  // ─── Revisión manual ───────────────────────────────────────────
  review(guildId, submissionId, { approve, reviewer, reason = null }) {
    const sub = this.store.getSubmission(Number(submissionId));
    if (!sub || sub.guildId !== guildId) throw new UserError('That submission does not exist.', 'NOT_FOUND');
    const task = this.store.getTask(sub.taskId);
    if (!task) throw new UserError('The task no longer exists.', 'NOT_FOUND');
    if (approve && sub.status === 'verified') throw new UserError('Already approved.', 'ALREADY');
    if (!approve && sub.status === 'rejected') throw new UserError('Already rejected.', 'ALREADY');

    const result = this.store.db.transaction(() => {
      const updated = this.store.setSubmissionStatus(sub.id, {
        status: approve ? 'verified' : 'rejected',
        reason: approve ? null : reason || 'Rejected by staff',
        reviewerId: reviewer?.id || 'panel',
      });
      this.store.adjustTrust(guildId, sub.userId, (t) =>
        applyTrust(t, approve ? (sub.method === 'screenshot' ? 'screenshot_approved' : 'manual_approved') : 'rejected_manual'),
      );
      if (!approve) this.store.incMember(guildId, sub.userId, 'rejected', 1);
      const sync = this.tasks.syncUserTask(task, sub.userId);
      return { updated, sync };
    });
    this.tasks.markDirty(task.id);
    this.bus?.change(guildId, 'submission', { taskId: task.id, userId: sub.userId });
    this.tasks.audit(
      guildId,
      'review',
      reviewer,
      `${approve ? 'Approved' : 'Rejected'}: ${ACTION_INFO[sub.action].label} by <@${sub.userId}> on #${task.id}${!approve && reason ? ` — ${reason}` : ''}`,
      { taskId: task.id, userId: sub.userId, submissionId: sub.id },
    );
    if (result.sync.completedNow) {
      this.tasks.audit(guildId, 'complete', null, `<@${sub.userId}> completed task #${task.id} (after review)`, { taskId: task.id, userId: sub.userId });
    }
    const decided = { approve, by: reviewer?.name || 'Staff', reason: approve ? null : reason || 'Rejected by staff' };
    this.tasks.publisher
      .reviewDecided(task, result.updated, decided)
      .catch((err) => this.log?.debug(`No se pudo notificar la revisión: ${err.message}`));
    return { submission: result.updated, progress: result.sync.progress, task, decided };
  }

  /** Marca manualmente una acción como hecha o no hecha (desde el panel). */
  setManual(guildId, taskId, userId, action, { done, reviewer }) {
    const task = this.store.getGuildTask(guildId, Number(taskId));
    if (!task) throw new UserError('That task does not exist.', 'NOT_FOUND');
    if (!task.actions.includes(action)) throw new UserError('This task does not include that action.', 'BAD_ACTION');
    const res = this.store.db.transaction(() => {
      this.store.ensureMember(guildId, userId);
      this.store.upsertSubmission({
        taskId: task.id,
        guildId,
        userId,
        action,
        status: done ? 'verified' : 'rejected',
        method: 'manual',
        reason: done ? null : 'Marked incomplete by staff',
        reviewerId: reviewer?.id || 'panel',
        countAttempt: false,
      });
      return this.tasks.syncUserTask(task, userId);
    });
    this.tasks.markDirty(task.id);
    this.bus?.change(guildId, 'submission', { taskId: task.id, userId });
    this.tasks.audit(guildId, 'review', reviewer, `${ACTION_INFO[action].label} by <@${userId}> marked as ${done ? 'done' : 'incomplete'} on #${task.id}`, {
      taskId: task.id,
      userId,
    });
    return res.progress;
  }
}

module.exports = { VerificationService, PROOF_TYPES, MAX_PROOF_BYTES };
