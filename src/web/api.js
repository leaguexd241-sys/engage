'use strict';

const fs = require('node:fs');
const express = require('express');
const ui = require('../discord/ui');
const { UserError, isUserError } = require('../core/errors');
const { ACTIONS, ACTION_INFO } = require('../core/settings');
const { progressFor } = require('../core/progress');
const { trustLevel } = require('../core/trust');
const { analyzeReply } = require('../core/quality');
const { parseTweetUrl } = require('../twitter/urls');
const { XError } = require('../twitter/errors');
const { parseDuration, clampDuration } = require('../util/time');
const { inviteUrl } = require('../discord/client');

/** Envuelve un manejador async: errores de usuario → 400, el resto → 500 registrado. */
const ah = (log) => (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (isUserError(err)) return res.status(err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : 400).json({ error: err.message, code: err.code, errors: err.errors });
    if (err?.code === 'BUSY') return res.status(503).json({ error: err.message });
    log.error(`Error en ${req.method} ${req.originalUrl}:`, err);
    return res.status(500).json({ error: 'Error interno del servidor. Revisa el registro del bot.' });
  }
  return undefined;
};

function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATE_LABEL = { complete: 'Completó', pending: 'En revisión', partial: 'Incompleta', none: 'No participó' };
const STATUS_LABEL = { verified: 'Hecho', pending: 'En revisión', awaiting: 'Falta captura', rejected: 'Rechazado', revoked: 'Anulado', none: '—' };

function createApi({ engine, auth, config, log, live, getBotInfo }) {
  const r = express.Router();
  const wrap = ah(log);
  const { store, tasks, verification, links } = engine;

  const actor = (req) => ({ id: req.session.uid === 'owner' ? null : req.session.uid, name: req.session.name || 'Panel' });

  // ─── Sesión ────────────────────────────────────────────────────
  r.get('/session', (req, res) => {
    res.json({
      authenticated: Boolean(req.session),
      user: req.session ? { id: req.session.uid, name: req.session.name, avatar: req.session.avatar, owner: Boolean(req.session.owner), method: req.session.method } : null,
      oauthEnabled: auth.oauthEnabled,
      simulator: Boolean(config.simulator),
      demo: Boolean(config.demo),
      version: config.version,
    });
  });

  r.post('/login', (req, res) => auth.passwordLogin(req, res));

  r.post('/logout', (req, res) => {
    auth.clearSession(res);
    res.json({ ok: true });
  });

  // A partir de aquí, todo requiere sesión.
  r.use(auth.requireAuth());

  r.post(
    '/sessions/revoke',
    wrap((req, res) => {
      if (!req.session.owner) throw new UserError('Sólo el propietario puede cerrar todas las sesiones.', 'FORBIDDEN');
      auth.revokeAll();
      auth.clearSession(res);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/status',
    wrap((req, res) => {
      const mem = process.memoryUsage();
      res.json({
        version: config.version,
        node: process.version,
        uptimeSec: Math.round(process.uptime()),
        startedAt: engine.startedAt,
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
        bot: getBotInfo(),
        x: engine.x.status(),
        live: live.clients.size,
        dataDir: req.session.owner ? config.dataDir : undefined,
        logs: req.session.owner ? log.root.recent.slice(-80) : [],
      });
    }),
  );

  r.get(
    '/invite',
    wrap((req, res) => {
      const info = getBotInfo();
      const id = config.discord.clientId || info.user?.id;
      res.json({ url: id && info.kind === 'discord' ? inviteUrl(id) : null });
    }),
  );

  r.get('/events', live.handler());

  // ─── Servidores ────────────────────────────────────────────────
  const listAccessibleGuilds = (session) => {
    const gw = engine.gateway;
    const live = gw ? gw.listGuilds() : [];
    const byId = new Map(live.map((g) => [g.id, { ...g, online: true }]));
    for (const row of store.listGuildRows()) {
      if (!byId.has(row.id) && row.active) byId.set(row.id, { id: row.id, name: row.name, icon: row.icon, memberCount: null, online: false });
    }
    return [...byId.values()]
      .filter((g) => auth.canAccessGuild(session, g.id))
      .map((g) => ({ ...g, activeTasks: store.activeTasks(g.id).length, pendingReviews: store.countPendingReviews(g.id) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
  };

  r.get('/guilds', wrap((req, res) => res.json({ guilds: listAccessibleGuilds(req.session) })));

  r.param('gid', (req, res, next, gid) => {
    if (!/^\d{5,25}$/.test(gid)) return res.status(400).json({ error: 'ID de servidor no válido.' });
    if (!auth.canAccessGuild(req.session, gid)) return res.status(403).json({ error: 'No tienes acceso a este servidor.' });
    req.gid = gid;
    return next();
  });

  r.get(
    '/guilds/:gid/meta',
    wrap(async (req, res) => {
      const gw = engine.gateway;
      const guild = gw ? await gw.getGuild(req.gid) : null;
      const row = store.getGuildRow(req.gid);
      res.json({
        guild: guild || (row ? { id: row.id, name: row.name, icon: row.icon } : { id: req.gid, name: req.gid }),
        online: Boolean(guild),
        channels: gw ? gw.listChannels(req.gid) : [],
        roles: gw ? gw.listRoles(req.gid) : [],
        settings: store.getSettings(req.gid),
        membersIntent: gw?.membersIntent !== false,
      });
    }),
  );

  r.put(
    '/guilds/:gid/settings',
    wrap((req, res) => {
      const settings = engine.updateSettings(req.gid, req.body || {}, actor(req));
      res.json({ settings });
    }),
  );

  r.get(
    '/guilds/:gid/overview',
    wrap(async (req, res) => {
      const gid = req.gid;
      const counts = store.guildCounts(gid);
      const daily = store.dailyActivity(gid, 14);
      const days = [];
      const map = new Map(daily.map((d) => [d.day, d]));
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400_000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const v = map.get(key);
        days.push({ day: key, verified: v?.verified || 0, rejected: v?.rejected || 0, users: v?.users || 0 });
      }
      const active = [];
      for (const t of store.activeTasks(gid).slice(0, 6)) {
        const view = await tasks.view(t);
        active.push({ id: t.id, tweet: t.tweet, actions: t.actions, endsAt: t.endsAt, createdAt: t.createdAt, completed: view.completed, participants: view.participants, expected: view.expectedCount });
      }
      const recentClosed = store
        .listTasks(gid, { status: 'closed', limit: 10 })
        .items.reverse()
        .map((t) => ({ id: t.id, completionRate: t.report?.completionRate ?? 0, completed: t.report?.completed?.length ?? 0, handle: t.tweet?.author?.handle }));
      res.json({
        counts,
        daily: days,
        active,
        recentClosed,
        top: store.leaderboard(gid, { sinceMs: Date.now() - 30 * 86400_000, limit: 6 }),
        breakdown: store.actionBreakdown(gid),
        recent: store.listAudit(gid, { limit: 12 }),
      });
    }),
  );

  // ─── Tareas ────────────────────────────────────────────────────
  r.post(
    '/tweet-preview',
    wrap(async (req, res) => {
      const parsed = parseTweetUrl(req.body?.url);
      if (!parsed) throw new UserError('Enlace de X no válido.');
      try {
        const tweet = await engine.x.getTweet(parsed.id);
        res.json({ tweet });
      } catch (err) {
        if (err instanceof XError) {
          const msg = { NOT_FOUND: 'No encontramos ese post (¿borrado o enlace incorrecto?).', PROTECTED: 'El post es de una cuenta privada.' }[err.code] || 'X no respondió, prueba de nuevo.';
          throw new UserError(msg, `X_${err.code}`);
        }
        throw err;
      }
    }),
  );

  r.post(
    '/quality',
    wrap((req, res) => {
      const text = String(req.body?.text || '').slice(0, 1000);
      res.json(analyzeReply(text, { tweetText: String(req.body?.tweetText || '').slice(0, 2000) }));
    }),
  );

  r.post(
    '/guilds/:gid/tasks/preview',
    wrap((req, res) => {
      const settings = store.getSettings(req.gid);
      const b = req.body || {};
      const tweet = b.tweet || {};
      const minutes = clampDuration(parseDuration(b.duration) || settings.defaultDurationMinutes);
      const fake = {
        id: '—',
        guildId: req.gid,
        status: 'active',
        tweet,
        tweetId: tweet.id || '0',
        tweetUrl: tweet.url || 'https://x.com',
        actions: tasks.normalizeActions(b.actions, settings.defaultActions),
        points: { ...settings.points, ...(b.points || {}) },
        note: b.note || null,
        pingRoleId: b.pingRoleId || null,
        messageId: null,
        createdAt: Date.now(),
        endsAt: Date.now() + minutes * 60_000,
      };
      const payload = ui.taskMessage(fake, { completed: 0, participants: 0, expectedCount: null, settings });
      // En la vista previa todavía no hay número de tarea.
      payload.embeds[0].title = payload.embeds[0].title.replace('Tarea #—', 'Nueva tarea');
      payload.embeds[0].footer.text = payload.embeds[0].footer.text.replace(' · ID —', '');
      res.json({ payload });
    }),
  );

  r.get(
    '/guilds/:gid/tasks',
    wrap((req, res) => {
      const status = ['active', 'closed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = 20;
      const { total, items } = store.listTasks(req.gid, { status, limit, offset: (page - 1) * limit, search: String(req.query.search || '').slice(0, 100) });
      const rows = items.map((t) => {
        const subs = store.taskSubmissions(t.id);
        const users = new Map();
        for (const s of subs) (users.get(s.userId) || users.set(s.userId, []).get(s.userId)).push(s);
        let completed = 0;
        for (const list of users.values()) if (progressFor(t, list).complete) completed += 1;
        return {
          id: t.id,
          status: t.status,
          tweet: { id: t.tweet?.id, text: t.tweet?.text, author: t.tweet?.author, media: t.tweet?.media?.slice(0, 1) },
          tweetUrl: t.tweetUrl,
          actions: t.actions,
          createdAt: t.createdAt,
          endsAt: t.endsAt,
          closedAt: t.closedAt,
          createdByName: t.createdByName,
          participants: users.size,
          completed,
          expected: t.report?.expectedCount ?? null,
          completionRate: t.report?.completionRate ?? null,
          pending: subs.filter((s) => s.status === 'pending').length,
          flags: t.flags?.length || 0,
        };
      });
      res.json({ total, page, pages: Math.max(1, Math.ceil(total / limit)), items: rows });
    }),
  );

  r.post(
    '/guilds/:gid/tasks',
    wrap(async (req, res) => {
      const b = req.body || {};
      const task = await tasks.create({
        guildId: req.gid,
        tweetUrl: b.tweetUrl,
        actions: Array.isArray(b.actions) ? b.actions.filter((a) => ACTIONS.includes(a)) : undefined,
        duration: b.duration,
        channelId: b.channelId || undefined,
        roleId: b.roleId === undefined ? undefined : b.roleId || null,
        pingRoleId: b.pingRoleId === undefined ? undefined : b.pingRoleId || null,
        note: b.note,
        points: b.points,
        createdBy: actor(req),
      });
      res.status(201).json({ task });
    }),
  );

  async function taskDetail(task) {
    const summary = await tasks.liveSummary(task);
    const subs = store.taskSubmissions(task.id);
    const describe = tasks.describeUser(task.guildId);
    const byUser = new Map();
    for (const s of subs) (byUser.get(s.userId) || byUser.set(s.userId, []).get(s.userId)).push(s);
    const names = new Map();
    for (const list of [summary.completed, summary.pending, summary.partial, summary.missing]) for (const u of list) names.set(u.id, u);
    const ids = new Set([...byUser.keys(), ...summary.missing.map((u) => u.id)]);
    const rows = [];
    for (const id of ids) {
      if (rows.length >= 3000) break;
      const list = byUser.get(id) || [];
      const p = progressFor(task, list);
      const info = { ...(names.get(id) || {}), ...describe(id) };
      const actions = {};
      for (const item of p.items) {
        const s = item.sub;
        actions[item.action] = s
          ? { id: s.id, status: s.status, method: s.method, quality: s.quality, evidenceUrl: s.evidenceUrl, evidenceText: s.evidenceText, reason: s.reason, updatedAt: s.updatedAt }
          : { status: 'none' };
      }
      rows.push({
        id,
        name: info.name || null,
        avatar: info.avatar || null,
        xHandle: info.xHandle || null,
        trust: info.trust ?? null,
        state: p.state,
        done: p.done,
        total: p.total,
        points: store.taskPointsFor(task.id, id),
        expected: summary.expectedIds?.includes(id) ?? false,
        actions,
      });
    }
    const order = { complete: 0, pending: 1, partial: 2, none: 3 };
    rows.sort((a, b) => order[a.state] - order[b.state] || String(a.name || a.id).localeCompare(String(b.name || b.id), 'es'));
    const { completed, pending, partial, missing, ...stats } = summary;
    return {
      task,
      stats: { ...stats, completed: completed.length, pending: pending.length, partial: partial.length, missing: missing.length },
      rows,
      messageUrl: ui.messageUrl(task.guildId, task.channelId, task.messageId),
    };
  }

  const getTask = (req) => tasks.get(req.gid, Number.parseInt(req.params.id, 10));

  r.get('/guilds/:gid/tasks/:id', wrap(async (req, res) => res.json(await taskDetail(getTask(req)))));

  r.post(
    '/guilds/:gid/tasks/:id/:op',
    wrap(async (req, res) => {
      const task = getTask(req);
      const a = actor(req);
      switch (req.params.op) {
        case 'close':
          await tasks.close(req.gid, task.id, { actor: a });
          break;
        case 'cancel':
          await tasks.cancel(req.gid, task.id, { actor: a });
          break;
        case 'remind': {
          const r2 = await tasks.remind(req.gid, task.id, { actor: a });
          return res.json({ ok: true, ...r2 });
        }
        case 'extend':
          await tasks.extend(req.gid, task.id, req.body?.duration || '30m', { actor: a });
          break;
        case 'recheck': {
          const revoked = await tasks.recheck(task);
          const m = await tasks.refreshMetrics(task).catch(() => null);
          return res.json({ ok: true, revoked, flags: m?.flags || [] });
        }
        case 'manual': {
          const { userId, action, done } = req.body || {};
          if (!/^\d{5,25}$/.test(String(userId))) throw new UserError('Usuario no válido.');
          if (!ACTIONS.includes(action)) throw new UserError('Acción no válida.');
          verification.setManual(req.gid, task.id, String(userId), action, { done: Boolean(done), reviewer: a });
          break;
        }
        default:
          throw new UserError('Operación desconocida.', 'NOT_FOUND');
      }
      return res.json({ ok: true, task: store.getTask(task.id) });
    }),
  );

  r.delete(
    '/guilds/:gid/tasks/:id',
    wrap(async (req, res) => {
      const task = getTask(req);
      await tasks.remove(req.gid, task.id, { actor: actor(req) });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/guilds/:gid/tasks/:id/export.csv',
    wrap(async (req, res) => {
      const detail = await taskDetail(getTask(req));
      const t = detail.task;
      const header = ['id_discord', 'nombre', 'cuenta_x', 'estado', ...t.actions.map((a) => ACTION_INFO[a].label.toLowerCase()), 'calidad_comentario', 'enlace_comentario', 'puntos'];
      const lines = [header.join(';')];
      for (const row of detail.rows) {
        const reply = row.actions.reply || row.actions.quote;
        lines.push(
          [
            row.id,
            row.name || '',
            row.xHandle ? `@${row.xHandle}` : '',
            STATE_LABEL[row.state],
            ...t.actions.map((a) => STATUS_LABEL[row.actions[a]?.status || 'none']),
            reply?.quality ?? '',
            reply?.evidenceUrl && !String(reply.evidenceUrl).startsWith('proof:') ? reply.evidenceUrl : '',
            row.points,
          ]
            .map(csvCell)
            .join(';'),
        );
      }
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="tarea-${t.id}.csv"`);
      res.send('﻿' + lines.join('\r\n'));
    }),
  );

  // ─── Revisiones ────────────────────────────────────────────────
  r.get(
    '/guilds/:gid/reviews',
    wrap((req, res) => {
      const describe = tasks.describeUser(req.gid);
      const items = store.pendingReviews(req.gid, { limit: 200 }).map((s) => ({ ...s, user: describe(s.userId), proofUrl: s.evidenceUrl?.startsWith('proof:') ? `/api/proofs/${s.evidenceUrl.slice(6)}` : null }));
      res.json({ items });
    }),
  );

  r.post(
    '/guilds/:gid/reviews/:sid',
    wrap((req, res) => {
      const result = verification.review(req.gid, Number.parseInt(req.params.sid, 10), {
        approve: Boolean(req.body?.approve),
        reviewer: actor(req),
        reason: req.body?.reason ? String(req.body.reason).slice(0, 300) : null,
      });
      res.json({ ok: true, submission: result.submission });
    }),
  );

  r.get(
    '/proofs/:file',
    wrap((req, res) => {
      const file = String(req.params.file);
      if (!/^[\w.-]+$/.test(file)) throw new UserError('Archivo no válido.', 'NOT_FOUND');
      const sub = engine.db.get('SELECT guild_id FROM submissions WHERE evidence_url = ?', `proof:${file}`);
      if (!sub || !auth.canAccessGuild(req.session, sub.guild_id)) throw new UserError('No encontrado.', 'NOT_FOUND');
      const full = verification.proofPath(`proof:${file}`);
      if (!full || !fs.existsSync(full)) throw new UserError('La captura ya no está disponible.', 'NOT_FOUND');
      res.setHeader('cache-control', 'private, max-age=3600');
      res.sendFile(full);
    }),
  );

  // ─── Miembros ──────────────────────────────────────────────────
  r.get(
    '/guilds/:gid/members',
    wrap((req, res) => {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = 25;
      const { total, items } = store.listMembers(req.gid, {
        search: String(req.query.search || '').slice(0, 100),
        sort: String(req.query.sort || 'points'),
        limit,
        offset: (page - 1) * limit,
      });
      res.json({ total, page, pages: Math.max(1, Math.ceil(total / limit)), items: items.map((m) => ({ ...m, level: trustLevel(m.trust) })) });
    }),
  );

  r.get(
    '/guilds/:gid/members/:uid',
    wrap((req, res) => {
      const uid = String(req.params.uid);
      const member = store.getMember(req.gid, uid);
      if (!member) throw new UserError('Ese miembro todavía no ha usado el bot en este servidor.', 'NOT_FOUND');
      const subs = engine.db
        .all('SELECT s.*, t.tweet_url FROM submissions s JOIN tasks t ON t.id = s.task_id WHERE s.guild_id = ? AND s.user_id = ? ORDER BY s.id DESC LIMIT 60', req.gid, uid)
        .map((row) => ({ id: row.id, taskId: row.task_id, action: row.action, status: row.status, method: row.method, quality: row.quality, reason: row.reason, evidenceUrl: row.evidence_url, updatedAt: row.updated_at, tweetUrl: row.tweet_url }));
      const ledger = engine.db.all('SELECT kind, amount, reason, task_id, created_at FROM points_ledger WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 40', req.gid, uid);
      res.json({ member: { ...member, level: trustLevel(member.trust) }, link: store.getLink(uid), rank: store.rankOf(req.gid, uid), submissions: subs, ledger });
    }),
  );

  r.patch(
    '/guilds/:gid/members/:uid',
    wrap((req, res) => {
      const uid = String(req.params.uid);
      if (!/^\d{5,25}$/.test(uid)) throw new UserError('Usuario no válido.');
      const b = req.body || {};
      const fields = {};
      if ('trust' in b) {
        const n = Number(b.trust);
        if (!Number.isFinite(n)) throw new UserError('Confianza no válida.');
        fields.trust = Math.max(0, Math.min(100, Math.round(n)));
      }
      if ('blacklisted' in b) fields.blacklisted = Boolean(b.blacklisted);
      if ('notes' in b) fields.notes = String(b.notes || '').slice(0, 1000) || null;
      store.updateMember(req.gid, uid, fields);
      tasks.audit(req.gid, 'member', actor(req), `Miembro <@${uid}> actualizado desde el panel (${Object.keys(fields).join(', ')})`, { userId: uid });
      engine.bus.change(req.gid, 'member', { userId: uid });
      res.json({ member: store.getMember(req.gid, uid) });
    }),
  );

  r.post(
    '/guilds/:gid/members/:uid/points',
    wrap((req, res) => {
      const uid = String(req.params.uid);
      if (!/^\d{5,25}$/.test(uid)) throw new UserError('Usuario no válido.');
      const amount = Math.round(Number(req.body?.amount));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) throw new UserError('Cantidad no válida.');
      const reason = String(req.body?.reason || 'Ajuste manual').slice(0, 200);
      store.ensureMember(req.gid, uid);
      store.addLedger({ guildId: req.gid, userId: uid, kind: 'manual', amount, reason });
      tasks.audit(req.gid, 'points', actor(req), `${amount > 0 ? '+' : ''}${amount} puntos a <@${uid}> (${reason})`, { userId: uid });
      engine.bus.change(req.gid, 'member', { userId: uid });
      res.json({ member: store.getMember(req.gid, uid) });
    }),
  );

  r.put(
    '/guilds/:gid/members/:uid/link',
    wrap((req, res) => {
      const uid = String(req.params.uid);
      if (!/^\d{5,25}$/.test(uid)) throw new UserError('Usuario no válido.');
      store.ensureMember(req.gid, uid);
      const link = links.adminLink({ userId: uid, handleInput: req.body?.handle, verified: req.body?.verified !== false, guildId: req.gid, actor: actor(req) });
      res.json({ link });
    }),
  );

  r.delete(
    '/guilds/:gid/members/:uid/link',
    wrap((req, res) => {
      const ok = links.unlink(String(req.params.uid), { guildId: req.gid, actor: actor(req) });
      res.json({ ok });
    }),
  );

  r.get(
    '/guilds/:gid/leaderboard',
    wrap((req, res) => {
      const period = String(req.query.period || 'all');
      const since = period === 'week' ? Date.now() - 7 * 86400_000 : period === 'month' ? Date.now() - 30 * 86400_000 : 0;
      res.json({ items: store.leaderboard(req.gid, { sinceMs: since, limit: 50 }) });
    }),
  );

  r.get(
    '/guilds/:gid/activity',
    wrap((req, res) => {
      const before = req.query.before ? Number.parseInt(req.query.before, 10) : null;
      const type = req.query.type ? String(req.query.type).slice(0, 20) : null;
      const items = store.listAudit(req.gid, { beforeId: Number.isFinite(before) ? before : null, limit: 50, type });
      res.json({ items, users: resolveMentions(req.gid, items.map((i) => i.message)) });
    }),
  );

  /** Resuelve los <@id> de los textos a nombres para mostrarlos bonitos en el panel. */
  function resolveMentions(gid, texts) {
    const ids = new Set();
    for (const t of texts) for (const m of String(t).matchAll(/<@!?(\d{5,25})>/g)) ids.add(m[1]);
    const out = {};
    const describe = tasks.describeUser(gid);
    for (const id of ids) out[id] = describe(id).name || null;
    return out;
  }

  r.post(
    '/guilds/:gid/mentions',
    wrap((req, res) => {
      const texts = Array.isArray(req.body?.texts) ? req.body.texts.slice(0, 200).map(String) : [];
      res.json({ users: resolveMentions(req.gid, texts) });
    }),
  );

  return r;
}

module.exports = { createApi, csvCell };
