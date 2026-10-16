'use strict';

const { withDefaults } = require('./settings');

const json = (v, fallback) => {
  if (v === null || v === undefined || v === '') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

function mapTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    guildId: r.guild_id,
    channelId: r.channel_id,
    messageId: r.message_id,
    tweetId: r.tweet_id,
    tweetUrl: r.tweet_url,
    tweet: json(r.tweet, {}),
    actions: json(r.actions, []),
    points: json(r.points, {}),
    note: r.note,
    roleId: r.role_id,
    pingRoleId: r.ping_role_id,
    status: r.status,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    endsAt: r.ends_at,
    closedAt: r.closed_at,
    remindedAt: r.reminded_at,
    metricsStart: json(r.metrics_start, null),
    metricsLast: json(r.metrics_last, null),
    metricsCheckedAt: r.metrics_checked_at,
    flags: json(r.flags, []),
    report: json(r.report, null),
  };
}

function mapSub(r) {
  if (!r) return null;
  return {
    id: r.id,
    taskId: r.task_id,
    guildId: r.guild_id,
    userId: r.user_id,
    action: r.action,
    status: r.status,
    method: r.method,
    evidenceUrl: r.evidence_url,
    evidenceId: r.evidence_id,
    evidenceText: r.evidence_text,
    quality: r.quality,
    details: json(r.details, {}),
    reason: r.reason,
    attempts: r.attempts,
    reviewerId: r.reviewer_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapLink(r) {
  if (!r) return null;
  return {
    userId: r.user_id,
    handle: r.handle,
    xId: r.x_id,
    xName: r.x_name,
    xAvatar: r.x_avatar,
    verified: Boolean(r.verified),
    method: r.method,
    protected: Boolean(r.protected),
    linkedAt: r.linked_at,
    verifiedAt: r.verified_at,
  };
}

function mapMember(r) {
  if (!r) return null;
  return {
    guildId: r.guild_id,
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name || r.username,
    avatar: r.avatar,
    trust: r.trust,
    streak: r.streak,
    bestStreak: r.best_streak,
    completed: r.completed,
    missed: r.missed,
    rejected: r.rejected,
    blacklisted: Boolean(r.blacklisted),
    notes: r.notes,
    lastActiveAt: r.last_active_at,
    createdAt: r.created_at,
    points: r.points ?? undefined,
  };
}

/** Acceso a datos. Todas las consultas están parametrizadas. */
class Store {
  constructor(db) {
    this.db = db;
    this.settingsCache = new Map();
  }

  // ─── Servidores ────────────────────────────────────────────────
  upsertGuild({ id, name, icon }) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO guilds (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, active = 1, updated_at = excluded.updated_at`,
      id,
      name || '',
      icon || null,
      now,
      now,
    );
  }

  setGuildActive(id, active) {
    this.db.run('UPDATE guilds SET active = ?, updated_at = ? WHERE id = ?', active ? 1 : 0, Date.now(), id);
  }

  getGuildRow(id) {
    return this.db.get('SELECT * FROM guilds WHERE id = ?', id);
  }

  listGuildRows() {
    return this.db.all('SELECT id, name, icon, active FROM guilds ORDER BY name');
  }

  getSettings(guildId) {
    const cached = this.settingsCache.get(guildId);
    if (cached) return cached;
    const row = this.db.get('SELECT settings FROM guilds WHERE id = ?', guildId);
    const settings = withDefaults(json(row?.settings, {}));
    if (row) this.settingsCache.set(guildId, settings);
    return settings;
  }

  saveSettings(guildId, settings) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO guilds (id, settings, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
      guildId,
      JSON.stringify(settings),
      now,
      now,
    );
    this.settingsCache.delete(guildId);
  }

  // ─── Cuentas de X vinculadas ───────────────────────────────────
  getLink(userId) {
    return mapLink(this.db.get('SELECT * FROM x_links WHERE user_id = ?', userId));
  }

  getLinkByHandle(handle) {
    return this.db.all('SELECT * FROM x_links WHERE handle_lc = ?', String(handle).toLowerCase()).map(mapLink);
  }

  saveLink({ userId, handle, xId = null, xName = null, xAvatar = null, verified, method, isProtected = false }) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO x_links (user_id, handle, handle_lc, x_id, x_name, x_avatar, verified, method, protected, linked_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle, handle_lc = excluded.handle_lc, x_id = excluded.x_id,
         x_name = excluded.x_name, x_avatar = excluded.x_avatar, verified = excluded.verified, method = excluded.method,
         protected = excluded.protected, linked_at = excluded.linked_at, verified_at = excluded.verified_at`,
      userId,
      handle,
      handle.toLowerCase(),
      xId,
      xName,
      xAvatar,
      verified ? 1 : 0,
      method,
      isProtected ? 1 : 0,
      now,
      verified ? now : null,
    );
    return this.getLink(userId);
  }

  deleteLink(userId) {
    return this.db.run('DELETE FROM x_links WHERE user_id = ?', userId).changes > 0;
  }

  getLinkRequest(userId) {
    const r = this.db.get('SELECT * FROM link_requests WHERE user_id = ?', userId);
    return r
      ? { userId: r.user_id, handle: r.handle, code: r.code, guildId: r.guild_id, attempts: r.attempts, createdAt: r.created_at, expiresAt: r.expires_at }
      : null;
  }

  saveLinkRequest({ userId, handle, code, guildId, ttlMs }) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO link_requests (user_id, handle, code, guild_id, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle, code = excluded.code, guild_id = excluded.guild_id,
         attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      userId,
      handle,
      code,
      guildId || null,
      now,
      now + ttlMs,
    );
    return this.getLinkRequest(userId);
  }

  bumpLinkAttempts(userId) {
    this.db.run('UPDATE link_requests SET attempts = attempts + 1 WHERE user_id = ?', userId);
  }

  deleteLinkRequest(userId) {
    this.db.run('DELETE FROM link_requests WHERE user_id = ?', userId);
  }

  pruneLinkRequests() {
    return this.db.run('DELETE FROM link_requests WHERE expires_at < ?', Date.now()).changes;
  }

  // ─── Miembros ──────────────────────────────────────────────────
  touchMember(guildId, user) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO members (guild_id, user_id, username, display_name, avatar, last_active_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET
         username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE members.username END,
         display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE members.display_name END,
         avatar = COALESCE(excluded.avatar, members.avatar),
         last_active_at = excluded.last_active_at`,
      guildId,
      user.id,
      user.username || '',
      user.displayName || user.globalName || '',
      user.avatar || null,
      now,
      now,
    );
    return this.getMember(guildId, user.id);
  }

  ensureMember(guildId, userId) {
    this.db.run(
      `INSERT INTO members (guild_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO NOTHING`,
      guildId,
      userId,
      Date.now(),
    );
  }

  getMember(guildId, userId) {
    return mapMember(
      this.db.get(
        `SELECT m.*, (SELECT COALESCE(SUM(amount), 0) FROM points_ledger l WHERE l.guild_id = m.guild_id AND l.user_id = m.user_id) AS points
         FROM members m WHERE m.guild_id = ? AND m.user_id = ?`,
        guildId,
        userId,
      ),
    );
  }

  listMembers(guildId, { search = '', sort = 'points', limit = 50, offset = 0 } = {}) {
    const order =
      {
        points: 'points DESC, m.completed DESC',
        trust: 'm.trust DESC',
        completed: 'm.completed DESC',
        missed: 'm.missed DESC',
        streak: 'm.streak DESC',
        recent: 'm.last_active_at DESC',
        name: 'lower(m.display_name) ASC',
      }[sort] || 'points DESC';
    const like = `%${String(search).replace(/[%_]/g, '')}%`;
    const rows = this.db.all(
      `SELECT m.*, COALESCE(p.total, 0) AS points, x.handle AS x_handle, x.verified AS x_verified
       FROM members m
       LEFT JOIN (SELECT user_id, SUM(amount) AS total FROM points_ledger WHERE guild_id = ? GROUP BY user_id) p ON p.user_id = m.user_id
       LEFT JOIN x_links x ON x.user_id = m.user_id
       WHERE m.guild_id = ? AND (? = '' OR m.username LIKE ? OR m.display_name LIKE ? OR x.handle LIKE ? OR m.user_id = ?)
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      guildId,
      guildId,
      search,
      like,
      like,
      like,
      search,
      Math.min(200, Math.max(1, limit)),
      Math.max(0, offset),
    );
    const total = this.db.get(
      `SELECT COUNT(*) AS c FROM members m LEFT JOIN x_links x ON x.user_id = m.user_id
       WHERE m.guild_id = ? AND (? = '' OR m.username LIKE ? OR m.display_name LIKE ? OR x.handle LIKE ? OR m.user_id = ?)`,
      guildId,
      search,
      like,
      like,
      like,
      search,
    ).c;
    return {
      total,
      items: rows.map((r) => ({ ...mapMember(r), xHandle: r.x_handle, xVerified: Boolean(r.x_verified) })),
    };
  }

  /** Miembros con cuenta de X vinculada en este servidor (se usa como "esperados" si no hay rol). */
  linkedMemberIds(guildId) {
    return this.db
      .all(
        `SELECT m.user_id FROM members m JOIN x_links x ON x.user_id = m.user_id
         WHERE m.guild_id = ? AND m.blacklisted = 0`,
        guildId,
      )
      .map((r) => r.user_id);
  }

  blacklistedIds(guildId) {
    return new Set(this.db.all('SELECT user_id FROM members WHERE guild_id = ? AND blacklisted = 1', guildId).map((r) => r.user_id));
  }

  updateMember(guildId, userId, fields) {
    const allowed = { trust: 'trust', blacklisted: 'blacklisted', notes: 'notes', streak: 'streak' };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(allowed)) {
      if (k in fields) {
        sets.push(`${col} = ?`);
        vals.push(k === 'blacklisted' ? (fields[k] ? 1 : 0) : fields[k]);
      }
    }
    if (!sets.length) return;
    this.ensureMember(guildId, userId);
    this.db.run(`UPDATE members SET ${sets.join(', ')} WHERE guild_id = ? AND user_id = ?`, ...vals, guildId, userId);
  }

  adjustTrust(guildId, userId, fn) {
    this.ensureMember(guildId, userId);
    const row = this.db.get('SELECT trust FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
    const next = fn(row.trust);
    this.db.run('UPDATE members SET trust = ? WHERE guild_id = ? AND user_id = ?', next, guildId, userId);
    return next;
  }

  incMember(guildId, userId, field, delta) {
    if (!['completed', 'missed', 'rejected'].includes(field)) throw new Error('campo no permitido');
    this.ensureMember(guildId, userId);
    this.db.run(`UPDATE members SET ${field} = MAX(0, ${field} + ?) WHERE guild_id = ? AND user_id = ?`, delta, guildId, userId);
  }

  setStreak(guildId, userId, completed) {
    this.ensureMember(guildId, userId);
    if (completed) {
      this.db.run(
        'UPDATE members SET streak = streak + 1, best_streak = MAX(best_streak, streak + 1) WHERE guild_id = ? AND user_id = ?',
        guildId,
        userId,
      );
    } else {
      this.db.run('UPDATE members SET streak = 0 WHERE guild_id = ? AND user_id = ?', guildId, userId);
    }
  }

  // ─── Puntos ────────────────────────────────────────────────────
  ledgerRow(taskId, userId, kind) {
    return this.db.get('SELECT * FROM points_ledger WHERE task_id = ? AND user_id = ? AND kind = ?', taskId, userId, kind);
  }

  addLedger({ guildId, userId, taskId = null, kind, amount, reason = null }) {
    this.db.run(
      `INSERT INTO points_ledger (guild_id, user_id, task_id, kind, amount, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      guildId,
      userId,
      taskId,
      kind,
      amount,
      reason,
      Date.now(),
    );
  }

  deleteLedger(taskId, userId, kind) {
    return this.db.run('DELETE FROM points_ledger WHERE task_id = ? AND user_id = ? AND kind = ?', taskId, userId, kind).changes > 0;
  }

  rankOf(guildId, userId) {
    const mine = this.db.get('SELECT COALESCE(SUM(amount), 0) AS p FROM points_ledger WHERE guild_id = ? AND user_id = ?', guildId, userId).p;
    if (mine <= 0) return null;
    const ahead = this.db.get(
      'SELECT COUNT(*) AS c FROM (SELECT user_id, SUM(amount) AS p FROM points_ledger WHERE guild_id = ? GROUP BY user_id HAVING p > ?)',
      guildId,
      mine,
    ).c;
    return ahead + 1;
  }

  /** IDs de tareas (de la lista dada) que el usuario ya completó. */
  completedTaskIds(userId, taskIds) {
    if (!taskIds.length) return new Set();
    return new Set(
      this.db
        .all(`SELECT task_id FROM points_ledger WHERE user_id = ? AND kind = 'bonus' AND task_id IN (SELECT value FROM json_each(?))`, userId, JSON.stringify(taskIds))
        .map((r) => r.task_id),
    );
  }

  taskPointsFor(taskId, userId) {
    return this.db.get('SELECT COALESCE(SUM(amount), 0) AS p FROM points_ledger WHERE task_id = ? AND user_id = ?', taskId, userId).p;
  }

  leaderboard(guildId, { sinceMs = 0, limit = 10 } = {}) {
    return this.db.all(
      `SELECT l.user_id, SUM(l.amount) AS points, m.username, m.display_name, m.avatar, m.trust, m.streak, m.completed, x.handle AS x_handle
       FROM points_ledger l
       LEFT JOIN members m ON m.guild_id = l.guild_id AND m.user_id = l.user_id
       LEFT JOIN x_links x ON x.user_id = l.user_id
       WHERE l.guild_id = ? AND l.created_at >= ?
       GROUP BY l.user_id
       HAVING SUM(l.amount) > 0
       ORDER BY points DESC, m.completed DESC
       LIMIT ?`,
      guildId,
      sinceMs,
      limit,
    );
  }

  // ─── Tareas ────────────────────────────────────────────────────
  insertTask(t) {
    const r = this.db.run(
      `INSERT INTO tasks (guild_id, channel_id, tweet_id, tweet_url, tweet, actions, points, note, role_id, ping_role_id,
         status, created_by, created_by_name, created_at, ends_at, metrics_start, metrics_last, metrics_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      t.guildId,
      t.channelId,
      t.tweetId,
      t.tweetUrl,
      JSON.stringify(t.tweet),
      JSON.stringify(t.actions),
      JSON.stringify(t.points),
      t.note || null,
      t.roleId || null,
      t.pingRoleId || null,
      t.createdBy || null,
      t.createdByName || null,
      t.createdAt,
      t.endsAt,
      t.metrics ? JSON.stringify(t.metrics) : null,
      t.metrics ? JSON.stringify(t.metrics) : null,
      t.metrics ? t.createdAt : null,
    );
    return this.getTask(Number(r.lastInsertRowid));
  }

  getTask(id) {
    return mapTask(this.db.get('SELECT * FROM tasks WHERE id = ?', id));
  }

  getGuildTask(guildId, id) {
    return mapTask(this.db.get('SELECT * FROM tasks WHERE id = ? AND guild_id = ?', id, guildId));
  }

  listTasks(guildId, { status = null, limit = 25, offset = 0, search = '' } = {}) {
    const like = `%${String(search).replace(/[%_]/g, '')}%`;
    const where = `guild_id = ? AND (? IS NULL OR status = ?) AND (? = '' OR tweet_url LIKE ? OR tweet LIKE ? OR CAST(id AS TEXT) = ?)`;
    const params = [guildId, status, status, search, like, like, search];
    const rows = this.db.all(`SELECT * FROM tasks WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = this.db.get(`SELECT COUNT(*) AS c FROM tasks WHERE ${where}`, ...params).c;
    return { total, items: rows.map(mapTask) };
  }

  activeTasks(guildId = null) {
    return (guildId
      ? this.db.all(`SELECT * FROM tasks WHERE status = 'active' AND guild_id = ? ORDER BY id DESC`, guildId)
      : this.db.all(`SELECT * FROM tasks WHERE status = 'active' ORDER BY ends_at ASC`)
    ).map(mapTask);
  }

  dueTasks(now) {
    return this.db.all(`SELECT * FROM tasks WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at ASC LIMIT 20`, now).map(mapTask);
  }

  updateTask(id, fields) {
    const cols = {
      channelId: 'channel_id',
      messageId: 'message_id',
      status: 'status',
      closedAt: 'closed_at',
      remindedAt: 'reminded_at',
      endsAt: 'ends_at',
      metricsLast: 'metrics_last',
      metricsCheckedAt: 'metrics_checked_at',
      flags: 'flags',
      report: 'report',
      tweet: 'tweet',
      note: 'note',
    };
    const sets = [];
    const vals = [];
    for (const [k, col] of Object.entries(cols)) {
      if (k in fields) {
        sets.push(`${col} = ?`);
        const v = fields[k];
        vals.push(['metricsLast', 'flags', 'report', 'tweet'].includes(k) && v !== null ? JSON.stringify(v) : v);
      }
    }
    if (!sets.length) return this.getTask(id);
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    return this.getTask(id);
  }

  /** Cambia el estado sólo si sigue siendo `from` (evita cierres dobles). */
  transitionTask(id, from, to, extra = {}) {
    const r = this.db.run(
      `UPDATE tasks SET status = ?, closed_at = COALESCE(?, closed_at) WHERE id = ? AND status = ?`,
      to,
      extra.closedAt ?? null,
      id,
      from,
    );
    return r.changes === 1;
  }

  deleteTask(id) {
    return this.db.transaction(() => {
      const bonusRows = this.db.all(`SELECT guild_id, user_id FROM points_ledger WHERE task_id = ? AND kind = 'bonus'`, id);
      for (const b of bonusRows) this.incMember(b.guild_id, b.user_id, 'completed', -1);
      this.db.run('DELETE FROM points_ledger WHERE task_id = ?', id);
      return this.db.run('DELETE FROM tasks WHERE id = ?', id).changes > 0;
    });
  }

  // ─── Envíos (participaciones) ──────────────────────────────────
  getSubmission(id) {
    return mapSub(this.db.get('SELECT * FROM submissions WHERE id = ?', id));
  }

  userSubmissions(taskId, userId) {
    return this.db.all('SELECT * FROM submissions WHERE task_id = ? AND user_id = ?', taskId, userId).map(mapSub);
  }

  taskSubmissions(taskId) {
    return this.db.all('SELECT * FROM submissions WHERE task_id = ? ORDER BY created_at ASC', taskId).map(mapSub);
  }

  upsertSubmission(s) {
    const now = Date.now();
    this.db.run(
      `INSERT INTO submissions (task_id, guild_id, user_id, action, status, method, evidence_url, evidence_id, evidence_text,
         quality, details, reason, attempts, reviewer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(task_id, user_id, action) DO UPDATE SET
         status = excluded.status, method = excluded.method, evidence_url = excluded.evidence_url,
         evidence_id = excluded.evidence_id, evidence_text = excluded.evidence_text, quality = excluded.quality,
         details = excluded.details, reason = excluded.reason, reviewer_id = excluded.reviewer_id,
         attempts = submissions.attempts + ?, updated_at = excluded.updated_at`,
      s.taskId,
      s.guildId,
      s.userId,
      s.action,
      s.status,
      s.method,
      s.evidenceUrl || null,
      s.evidenceId || null,
      s.evidenceText || null,
      s.quality ?? null,
      JSON.stringify(s.details || {}),
      s.reason || null,
      s.reviewerId || null,
      now,
      now,
      s.countAttempt === false ? 0 : 1,
    );
    return mapSub(
      this.db.get('SELECT * FROM submissions WHERE task_id = ? AND user_id = ? AND action = ?', s.taskId, s.userId, s.action),
    );
  }

  setSubmissionStatus(id, { status, reason = null, reviewerId = null, method = null, evidenceUrl = null }) {
    this.db.run(
      `UPDATE submissions SET status = ?, reason = ?, reviewer_id = COALESCE(?, reviewer_id), method = COALESCE(?, method),
         evidence_url = COALESCE(?, evidence_url), updated_at = ? WHERE id = ?`,
      status,
      reason,
      reviewerId,
      method,
      evidenceUrl,
      Date.now(),
      id,
    );
    return this.getSubmission(id);
  }

  mergeSubmissionDetails(id, patch) {
    const sub = this.getSubmission(id);
    if (!sub) return null;
    this.db.run('UPDATE submissions SET details = ? WHERE id = ?', JSON.stringify({ ...sub.details, ...patch }), id);
    return this.getSubmission(id);
  }

  /** Textos de comentarios ya aceptados en la tarea (para detectar copias). */
  replyTextsForTask(taskId, excludeUserId) {
    return this.db
      .all(
        `SELECT user_id, evidence_text AS text, evidence_url AS url FROM submissions
         WHERE task_id = ? AND action IN ('reply', 'quote') AND status IN ('verified', 'pending') AND user_id <> ? AND evidence_text IS NOT NULL`,
        taskId,
        excludeUserId,
      )
      .map((r) => ({ userId: r.user_id, text: r.text, url: r.url }));
  }

  recentUserReplies(guildId, userId, excludeTaskId, limit = 30) {
    return this.db
      .all(
        `SELECT task_id, evidence_text AS text, evidence_url AS url FROM submissions
         WHERE guild_id = ? AND user_id = ? AND task_id <> ? AND action IN ('reply', 'quote') AND status = 'verified' AND evidence_text IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
        guildId,
        userId,
        excludeTaskId,
        limit,
      )
      .map((r) => ({ userId, taskId: r.task_id, text: r.text, url: r.url, own: true }));
  }

  pendingReviews(guildId, { limit = 100 } = {}) {
    return this.db
      .all(
        `SELECT s.*, t.tweet_url, t.status AS task_status FROM submissions s JOIN tasks t ON t.id = s.task_id
         WHERE s.guild_id = ? AND s.status = 'pending' ORDER BY s.updated_at ASC LIMIT ?`,
        guildId,
        limit,
      )
      .map((r) => ({ ...mapSub(r), tweetUrl: r.tweet_url, taskStatus: r.task_status }));
  }

  countPendingReviews(guildId) {
    return this.db.get(`SELECT COUNT(*) AS c FROM submissions WHERE guild_id = ? AND status = 'pending'`, guildId).c;
  }

  // ─── Registro de actividad ─────────────────────────────────────
  addAudit({ guildId = null, type, actorId = null, actorName = null, message, data = null }) {
    const r = this.db.run(
      `INSERT INTO audit_log (guild_id, type, actor_id, actor_name, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      guildId,
      type,
      actorId,
      actorName,
      String(message).slice(0, 1000),
      data ? JSON.stringify(data) : null,
      Date.now(),
    );
    return {
      id: Number(r.lastInsertRowid),
      guildId,
      type,
      actorId,
      actorName,
      message,
      data,
      createdAt: Date.now(),
    };
  }

  listAudit(guildId, { beforeId = null, limit = 50, type = null } = {}) {
    return this.db
      .all(
        `SELECT * FROM audit_log WHERE guild_id = ? AND (? IS NULL OR id < ?) AND (? IS NULL OR type = ?) ORDER BY id DESC LIMIT ?`,
        guildId,
        beforeId,
        beforeId,
        type,
        type,
        Math.min(200, limit),
      )
      .map((r) => ({
        id: r.id,
        guildId: r.guild_id,
        type: r.type,
        actorId: r.actor_id,
        actorName: r.actor_name,
        message: r.message,
        data: json(r.data, null),
        createdAt: r.created_at,
      }));
  }

  pruneAudit(olderThanMs) {
    return this.db.run('DELETE FROM audit_log WHERE created_at < ?', Date.now() - olderThanMs).changes;
  }

  // ─── Estadísticas ──────────────────────────────────────────────
  dailyActivity(guildId, days = 14) {
    const since = Date.now() - days * 86400_000;
    return this.db.all(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              COUNT(DISTINCT user_id) AS users
       FROM submissions WHERE guild_id = ? AND created_at >= ? GROUP BY day ORDER BY day`,
      guildId,
      since,
    );
  }

  guildCounts(guildId) {
    return this.db.get(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE guild_id = ?1 AND status = 'active') AS active_tasks,
         (SELECT COUNT(*) FROM tasks WHERE guild_id = ?1) AS total_tasks,
         (SELECT COUNT(*) FROM members WHERE guild_id = ?1) AS members,
         (SELECT COUNT(*) FROM members m JOIN x_links x ON x.user_id = m.user_id WHERE m.guild_id = ?1) AS linked,
         (SELECT COUNT(*) FROM submissions WHERE guild_id = ?1 AND status = 'verified') AS verified,
         (SELECT COUNT(*) FROM submissions WHERE guild_id = ?1 AND status = 'pending') AS pending,
         (SELECT COUNT(*) FROM submissions WHERE guild_id = ?1 AND status IN ('rejected', 'revoked')) AS rejected,
         (SELECT COUNT(*) FROM submissions WHERE guild_id = ?1 AND action IN ('reply','quote') AND status = 'verified') AS replies,
         (SELECT ROUND(AVG(quality)) FROM submissions WHERE guild_id = ?1 AND action IN ('reply','quote') AND status = 'verified') AS avg_quality`,
      guildId,
    );
  }

  actionBreakdown(guildId) {
    return this.db.all(
      `SELECT action, method, COUNT(*) AS c FROM submissions WHERE guild_id = ? AND status = 'verified' GROUP BY action, method`,
      guildId,
    );
  }

  kvGet(key) {
    return this.db.get('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }

  kvSet(key, value) {
    this.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}

module.exports = { Store, mapTask, mapSub };
