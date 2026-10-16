'use strict';

const { UserError } = require('./errors');
const { ACTIONS } = require('./settings');
const { progressFor, summarize, computeFlags } = require('./progress');
const { applyTrust } = require('./trust');
const { parseTweetUrl } = require('../twitter/urls');
const { XError } = require('../twitter/errors');
const { parseDuration, clampDuration } = require('../util/time');
const { LruCache } = require('../util/lru');
const { mapLimit } = require('../util/limiter');
const { KeyedLock } = require('../util/ratelimit');

/** Publicador por defecto cuando el bot no está conectado a Discord. */
const OFFLINE_PUBLISHER = {
  online: false,
  async postTask() {
    throw new UserError('The bot is not connected to Discord. Check the token and connection status.', 'OFFLINE');
  },
  async updateTask() {},
  async deleteTaskMessage() {},
  async sendReminder() {
    return { sent: 0 };
  },
  async sendReport() {},
  async reviewRequest() {
    return null;
  },
  async reviewDecided() {},
  async logEvent() {},
};

const MAX_REPORT_LIST = 2000;

class TaskService {
  constructor({ store, x, bus, log, gateway = null }) {
    this.store = store;
    this.x = x;
    this.bus = bus;
    this.log = log;
    this.gateway = gateway;
    this.publisher = OFFLINE_PUBLISHER;
    this.roleCache = new LruCache({ max: 200, ttlMs: 60_000 });
    this.dirty = new Set();
    this.creationLock = new KeyedLock();
    this.lastManualReminder = new LruCache({ max: 1000, ttlMs: 10 * 60_000 });
  }

  setPublisher(p) {
    if (!p) {
      this.publisher = OFFLINE_PUBLISHER;
      return;
    }
    // Completa los métodos que falten con los del publicador "desconectado".
    const wrapped = {
      get online() {
        return p.online !== false;
      },
    };
    for (const k of Object.keys(OFFLINE_PUBLISHER)) {
      if (k === 'online') continue;
      // Se resuelve en cada llamada (no al conectar), así siempre se usa el método actual.
      wrapped[k] = (...args) => (typeof p[k] === 'function' ? p[k](...args) : OFFLINE_PUBLISHER[k](...args));
    }
    this.publisher = wrapped;
  }

  setGateway(g) {
    this.gateway = g;
    this.roleCache.clear();
  }

  // ─── Creación ──────────────────────────────────────────────────
  normalizeActions(list, fallback) {
    const arr = Array.isArray(list) ? list : String(list || '').split(/[,\s+]+/);
    const set = new Set(arr.map((a) => String(a).trim().toLowerCase()).filter((a) => ACTIONS.includes(a)));
    const out = ACTIONS.filter((a) => set.has(a));
    return out.length ? out : [...fallback];
  }

  async create(input) {
    const parsed = parseTweetUrl(input.tweetUrl);
    const result = await this.creationLock.run(`${input.guildId}:${parsed?.id || input.tweetUrl}`, () => this._create(input));
    if (result.busy) throw new UserError('A task is already being created for this post. Please wait a few seconds.', 'BUSY');
    return result.value;
  }

  async _create(input) {
    const guildId = input.guildId;
    const settings = this.store.getSettings(guildId);
    const parsed = parseTweetUrl(input.tweetUrl);
    if (!parsed) throw new UserError('Invalid X post link. Example: `https://x.com/user/status/1234567890`', 'BAD_URL');

    const channelId = input.channelId || settings.tasksChannelId;
    if (!channelId) {
      throw new UserError('No task channel is configured. Choose a channel or set one with `/config channel`.', 'NO_CHANNEL');
    }

    const actions = this.normalizeActions(input.actions, settings.defaultActions);
    let duration = settings.defaultDurationMinutes;
    if (input.duration !== undefined && input.duration !== null && input.duration !== '') {
      const d = parseDuration(input.duration);
      if (!d) throw new UserError('Invalid duration. Use for example `30m`, `2h`, `1d` or `1h30m`.', 'BAD_DURATION');
      duration = d;
    }
    duration = clampDuration(duration);

    const points = { ...settings.points };
    if (input.points && typeof input.points === 'object') {
      for (const k of [...ACTIONS, 'bonus']) {
        const n = Number(input.points[k]);
        if (k in input.points && Number.isFinite(n)) points[k] = Math.max(0, Math.min(1000, Math.round(n)));
      }
    } else if (input.pointsMultiplier) {
      const m = Math.max(0.1, Math.min(20, Number(input.pointsMultiplier) || 1));
      for (const k of Object.keys(points)) points[k] = Math.round(points[k] * m);
    }

    const dup = this.store.activeTasks(guildId).find((t) => t.tweetId === parsed.id);
    if (dup) throw new UserError(`There is already an active task for that post (**#${dup.id}**).`, 'DUPLICATE');

    let tweet;
    try {
      tweet = await this.x.getTweet(parsed.id, { fresh: true });
    } catch (err) {
      if (err instanceof XError) {
        if (err.code === 'NOT_FOUND') throw new UserError('Could not find that post on X. Check the link and whether it was deleted.', 'X_NOT_FOUND');
        if (err.code === 'PROTECTED') throw new UserError('That post is from a private account. Members cannot interact with or verify it.', 'X_PROTECTED');
        throw new UserError('X is temporarily unavailable. Try again later.', 'X_UNAVAILABLE');
      }
      throw err;
    }

    const now = Date.now();
    const roleId = input.roleId === undefined ? settings.participantRoleId : input.roleId || null;
    const pingRoleId = input.pingRoleId === undefined ? settings.pingRoleId : input.pingRoleId || null;
    const note = input.note ? String(input.note).trim().slice(0, 500) : null;

    const task = this.store.insertTask({
      guildId,
      channelId,
      tweetId: tweet.id,
      tweetUrl: tweet.url,
      tweet,
      actions,
      points,
      note,
      roleId,
      pingRoleId,
      createdBy: input.createdBy?.id || null,
      createdByName: input.createdBy?.name || null,
      createdAt: now,
      endsAt: now + duration * 60_000,
      metrics: tweet.metrics,
    });

    let posted;
    try {
      posted = await this.publisher.postTask(task, await this.view(task));
    } catch (err) {
      this.store.deleteTask(task.id);
      if (err instanceof UserError) throw err;
      this.log?.warn(`No se pudo publicar the task en ${channelId}: ${err.message}`);
      throw new UserError(`Could not publish the task in channel <#${channelId}>. Check the View Channel, Send Messages and Embed Links permissions. (${err.message})`, 'POST_FAILED');
    }
    const saved = this.store.updateTask(task.id, { channelId: posted.channelId, messageId: posted.messageId });
    this.audit(guildId, 'task', input.createdBy, `Task #${task.id} created for ${tweet.url} (${actions.join(', ')}, ${duration} min)`, { taskId: task.id });
    this.bus?.change(guildId, 'task', { taskId: task.id });
    return saved;
  }

  // ─── Consultas ─────────────────────────────────────────────────
  get(guildId, id) {
    const task = this.store.getGuildTask(guildId, Number(id));
    if (!task) throw new UserError(`Task not found: #${id} in this server.`, 'NOT_FOUND');
    return task;
  }

  isOpen(task) {
    return task.status === 'active' && task.endsAt > Date.now();
  }

  progress(task, userId) {
    return progressFor(task, this.store.userSubmissions(task.id, userId));
  }

  /** Miembros que deberían hacer la tarea (rol de participantes o, si no hay, miembros con X vinculada). */
  async resolveExpected(task) {
    const blacklist = this.store.blacklistedIds(task.guildId);
    if (task.roleId && this.gateway?.getRoleMembers) {
      const key = `${task.guildId}:${task.roleId}`;
      let members = this.roleCache.get(key);
      if (!members) {
        try {
          members = await this.gateway.getRoleMembers(task.guildId, task.roleId);
        } catch (err) {
          this.log?.warn(`No se pudieron obtener los miembros del role ${task.roleId}: ${err.message}`);
          members = null;
        }
        if (members) this.roleCache.set(key, members);
      }
      if (members) {
        return { source: 'role', roleId: task.roleId, members: members.filter((m) => !m.bot && !blacklist.has(m.id)) };
      }
    }
    const ids = this.store.linkedMemberIds(task.guildId);
    if (!ids.length) return null;
    return {
      source: 'linked',
      members: ids.filter((id) => !blacklist.has(id)).map((id) => {
        const m = this.store.getMember(task.guildId, id);
        return { id, name: m?.displayName || m?.username || id, avatar: m?.avatar || null };
      }),
    };
  }

  describeUser(guildId) {
    const cache = new Map();
    return (id) => {
      if (cache.has(id)) return cache.get(id);
      const m = this.store.db.get(
        'SELECT m.display_name, m.username, m.avatar, m.trust, x.handle FROM members m LEFT JOIN x_links x ON x.user_id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?',
        guildId,
        id,
      );
      const info = m ? { name: m.display_name || m.username || undefined, avatar: m.avatar || undefined, xHandle: m.handle || null, trust: m.trust } : {};
      for (const k of Object.keys(info)) if (info[k] === undefined) delete info[k];
      cache.set(id, info);
      return info;
    };
  }

  async summary(task) {
    const subs = this.store.taskSubmissions(task.id);
    const expected = await this.resolveExpected(task);
    const s = summarize(task, subs, expected, this.describeUser(task.guildId));
    s.expectedIds = expected ? expected.members.map((m) => m.id) : [];
    return s;
  }

  /**
   * Resumen para el panel. En tareas cerradas se usan los "esperados" guardados al cerrar
   * (para que el historial no cambie si luego cambian los roles), pero los estados son los actuales
   * (por si el staff aprobó algo después).
   */
  async liveSummary(task) {
    if (task.status === 'active' || !task.report) return this.summary(task);
    const r = task.report;
    const names = new Map();
    for (const list of [r.completed, r.pending, r.partial, r.missing]) for (const u of list || []) names.set(u.id, u);
    const expected = r.expectedSource ? { source: r.expectedSource, members: (r.expectedIds || []).map((id) => ({ id, name: names.get(id)?.name, avatar: names.get(id)?.avatar })) } : null;
    const s = summarize(task, this.store.taskSubmissions(task.id), expected, this.describeUser(task.guildId));
    s.expectedIds = r.expectedIds || [];
    return s;
  }

  /** Datos que necesita el mensaje de la tarea en Discord. */
  async view(task) {
    const subs = this.store.taskSubmissions(task.id);
    const users = new Map();
    for (const s of subs) {
      if (!users.has(s.userId)) users.set(s.userId, []);
      users.get(s.userId).push(s);
    }
    let completed = 0;
    for (const list of users.values()) if (progressFor(task, list).complete) completed += 1;
    let expectedCount = null;
    if (task.roleId) {
      const exp = await this.resolveExpected(task);
      if (exp?.source === 'role') expectedCount = exp.members.length;
    }
    return { completed, participants: users.size, expectedCount, settings: this.store.getSettings(task.guildId) };
  }

  // ─── Puntos y estado de cada usuario ───────────────────────────
  /**
   * Sincroniza puntos, bonus y contadores de un usuario con el estado real de sus envíos.
   * Es idempotente: se puede llamar tantas veces como se quiera. Debe ejecutarse dentro de una transacción.
   */
  syncUserTask(task, userId) {
    const subs = this.store.userSubmissions(task.id, userId);
    const p = progressFor(task, subs);
    for (const item of p.items) {
      const has = Boolean(this.store.ledgerRow(task.id, userId, item.action));
      const should = item.status === 'verified';
      if (should && !has) {
        this.store.addLedger({ guildId: task.guildId, userId, taskId: task.id, kind: item.action, amount: task.points[item.action] || 0, reason: `Task #${task.id}` });
      } else if (!should && has) {
        this.store.deleteLedger(task.id, userId, item.action);
      }
    }
    const wasComplete = Boolean(this.store.ledgerRow(task.id, userId, 'bonus'));
    let completedNow = false;
    let uncompletedNow = false;
    if (p.complete && !wasComplete) {
      this.store.addLedger({ guildId: task.guildId, userId, taskId: task.id, kind: 'bonus', amount: task.points.bonus || 0, reason: `Task #${task.id} complete` });
      this.store.incMember(task.guildId, userId, 'completed', 1);
      this.store.adjustTrust(task.guildId, userId, (t) => applyTrust(t, 'task_completed'));
      completedNow = true;
    } else if (!p.complete && wasComplete) {
      this.store.deleteLedger(task.id, userId, 'bonus');
      this.store.incMember(task.guildId, userId, 'completed', -1);
      uncompletedNow = true;
    }
    return { progress: p, completedNow, uncompletedNow };
  }

  markDirty(taskId) {
    this.dirty.add(taskId);
  }

  /** Actualiza en Discord los mensajes de tareas con cambios (agrupado para no chocar con los límites de Discord). */
  async flushDirty() {
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const task = this.store.getTask(id);
      if (!task || !task.messageId) continue;
      try {
        await this.publisher.updateTask(task, await this.view(task));
      } catch (err) {
        this.log?.warn(`No se pudo actualizar el mensaje de the task #${id}: ${err.message}`);
      }
    }
  }

  // ─── Ciclo de vida ─────────────────────────────────────────────
  async close(guildId, id, { actor = null } = {}) {
    const task = this.get(guildId, id);
    if (task.status !== 'active') throw new UserError(`Task #${id} is already ${task.status === 'closed' ? 'closed' : 'cancelled'}.`, 'NOT_ACTIVE');
    const result = await this._close(task, actor);
    if (!result) throw new UserError('This task is already being closed.', 'NOT_ACTIVE');
    return result;
  }

  async _close(task, actor) {
    const now = Date.now();
    if (!this.store.transitionTask(task.id, 'active', 'closed', { closedAt: now })) return null;
    const settings = this.store.getSettings(task.guildId);
    let revoked = 0;
    if (settings.verification.recheckOnClose) {
      try {
        revoked = await this.recheck(task);
      } catch (err) {
        this.log?.warn(`Recomprobación de the task #${task.id} falló: ${err.message}`);
      }
    }
    try {
      await this.refreshMetrics(task);
    } catch (err) {
      this.log?.debug(`Métricas de the task #${task.id} no disponibles: ${err.message}`);
    }

    const fresh = this.store.getTask(task.id);
    const summary = await this.summary(fresh);
    this.store.db.transaction(() => {
      for (const u of summary.completed) this.store.setStreak(fresh.guildId, u.id, true);
      if (summary.expectedCount !== null) {
        for (const u of [...summary.missing, ...summary.partial]) {
          this.store.setStreak(fresh.guildId, u.id, false);
          this.store.incMember(fresh.guildId, u.id, 'missed', 1);
          this.store.adjustTrust(fresh.guildId, u.id, (t) => applyTrust(t, 'task_missed'));
        }
      }
    });
    const report = {
      ...summary,
      completed: summary.completed.slice(0, MAX_REPORT_LIST),
      pending: summary.pending.slice(0, MAX_REPORT_LIST),
      partial: summary.partial.slice(0, MAX_REPORT_LIST),
      missing: summary.missing.slice(0, MAX_REPORT_LIST),
      expectedIds: summary.expectedIds.slice(0, 5000),
      revoked,
      flags: fresh.flags,
      closedAt: now,
    };
    const closed = this.store.updateTask(task.id, { report });

    try {
      await this.publisher.updateTask(closed, await this.view(closed));
    } catch (err) {
      this.log?.warn(`No se pudo marcar como closed the task #${task.id} en Discord: ${err.message}`);
    }
    if (settings.report.enabled) {
      try {
        await this.publisher.sendReport(closed, summary, settings);
      } catch (err) {
        this.log?.warn(`No se pudo enviar el informe de the task #${task.id}: ${err.message}`);
      }
    }
    this.audit(
      task.guildId,
      'task',
      actor,
      `Task #${task.id} closed: ${summary.completed.length} completed, ${summary.notCompletedCount} did not complete (${summary.completionRate}%)`,
      { taskId: task.id },
    );
    this.bus?.change(task.guildId, 'task', { taskId: task.id, closed: true });
    return summary;
  }

  async cancel(guildId, id, { actor = null } = {}) {
    const task = this.get(guildId, id);
    if (!this.store.transitionTask(task.id, 'active', 'cancelled', { closedAt: Date.now() })) {
      throw new UserError(`Task #${id} is not active.`, 'NOT_ACTIVE');
    }
    const t = this.store.getTask(task.id);
    try {
      await this.publisher.updateTask(t, await this.view(t));
    } catch (err) {
      this.log?.warn(`No se pudo actualizar the task cancelled #${id}: ${err.message}`);
    }
    this.audit(guildId, 'task', actor, `Task #${id} cancelled`, { taskId: task.id });
    this.bus?.change(guildId, 'task', { taskId: task.id });
    return t;
  }

  async remove(guildId, id, { actor = null } = {}) {
    const task = this.get(guildId, id);
    try {
      await this.publisher.deleteTaskMessage(task);
    } catch (err) {
      this.log?.debug(`No se pudo borrar el mensaje de the task #${id}: ${err.message}`);
    }
    this.store.deleteTask(task.id);
    this.dirty.delete(task.id);
    this.audit(guildId, 'task', actor, `Task #${id} deleted (including its points and records)`, { taskId: task.id });
    this.bus?.change(guildId, 'task', { taskId: task.id, deleted: true });
    return true;
  }

  async extend(guildId, id, minutesInput, { actor = null } = {}) {
    const task = this.get(guildId, id);
    if (task.status !== 'active') throw new UserError('Only active tasks can be extended.', 'NOT_ACTIVE');
    const minutes = parseDuration(minutesInput);
    if (!minutes) throw new UserError('Invalid duration.', 'BAD_DURATION');
    const base = Math.max(task.endsAt, Date.now());
    const endsAt = Math.min(base + minutes * 60_000, task.createdAt + 30 * 86400_000);
    const t = this.store.updateTask(task.id, { endsAt, remindedAt: null });
    this.markDirty(task.id);
    this.audit(guildId, 'task', actor, `Task #${id} extended by ${minutes} min`, { taskId: task.id });
    this.bus?.change(guildId, 'task', { taskId: task.id });
    return t;
  }

  /** Recuerda la tarea a quienes aún no la completaron. */
  async remind(guildId, id, { actor = null, manual = true } = {}) {
    const task = this.get(guildId, id);
    if (!this.isOpen(task)) throw new UserError('The task has ended.', 'NOT_ACTIVE');
    if (manual) {
      const last = this.lastManualReminder.get(task.id);
      if (last && Date.now() - last < 5 * 60_000) {
        throw new UserError('A reminder was already sent less than 5 minutes ago.', 'COOLDOWN');
      }
      this.lastManualReminder.set(task.id, Date.now());
    }
    const summary = await this.summary(task);
    const targets = [...summary.missing, ...summary.partial, ...summary.pending.filter((u) => Object.values(u.actions).includes('awaiting'))];
    const settings = this.store.getSettings(guildId);
    const result = await this.publisher.sendReminder(task, targets, settings.reminders.mode, settings);
    this.store.updateTask(task.id, { remindedAt: Date.now() });
    this.audit(guildId, 'reminder', actor, `Task #${task.id}: reminder sent to ${targets.length} members`, { taskId: task.id });
    this.bus?.change(guildId, 'task', { taskId: task.id });
    return { targets: targets.length, ...result };
  }

  // ─── Antifraude ────────────────────────────────────────────────
  /** Comprueba que los comentarios/citas verificados siguen existiendo. Devuelve cuántos se revocaron. */
  async recheck(task) {
    const subs = this.store.taskSubmissions(task.id).filter((s) => s.status === 'verified' && s.evidenceId && (s.action === 'reply' || s.action === 'quote'));
    let revoked = 0;
    await mapLimit(subs, 3, async (s) => {
      try {
        await this.x.getTweet(s.evidenceId, { fresh: true });
      } catch (err) {
        if (err instanceof XError && err.code === 'NOT_FOUND') {
          this.store.db.transaction(() => {
            this.store.setSubmissionStatus(s.id, { status: 'revoked', reason: 'The post was deleted after verification' });
            this.store.incMember(task.guildId, s.userId, 'rejected', 1);
            this.store.adjustTrust(task.guildId, s.userId, (t) => applyTrust(t, 'revoked'));
            this.syncUserTask(task, s.userId);
          });
          revoked += 1;
          this.audit(task.guildId, 'fraud', null, `Task #${task.id}: revoked the ${s.action === 'reply' ? 'reply' : 'quoted post'} by <@${s.userId}> (deleted)`, {
            taskId: task.id,
            userId: s.userId,
          });
        }
      }
    });
    if (revoked) this.markDirty(task.id);
    return revoked;
  }

  async refreshMetrics(task) {
    const tweet = await this.x.getTweet(task.tweetId, { fresh: true });
    const subs = this.store.taskSubmissions(task.id);
    const flags = computeFlags(task, subs, task.metricsStart, tweet.metrics);
    const prevFlags = JSON.stringify(task.flags || []);
    this.store.updateTask(task.id, { metricsLast: tweet.metrics, metricsCheckedAt: Date.now(), flags });
    if (JSON.stringify(flags) !== prevFlags && flags.length) {
      for (const f of flags) this.audit(task.guildId, 'fraud', null, `Task #${task.id}: ${f.message}`, { taskId: task.id });
    }
    return { metrics: tweet.metrics, flags };
  }

  audit(guildId, type, actor, message, data = null) {
    const entry = this.store.addAudit({ guildId, type, actorId: actor?.id || null, actorName: actor?.name || null, message, data });
    this.bus?.emit('audit', entry);
    return entry;
  }
}

module.exports = { TaskService, OFFLINE_PUBLISHER };
