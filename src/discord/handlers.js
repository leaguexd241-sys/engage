'use strict';

const { PermissionFlagsBits } = require('discord.js');
const ui = require('./ui');
const { UserError, isUserError } = require('../core/errors');
const { ACTION_INFO } = require('../core/settings');
const { Cooldown } = require('../util/ratelimit');
const { parseDuration, formatDuration, discordTs } = require('../util/time');
const { truncate, fmtNum } = require('../util/text');

function noFlags(payload) {
  const { flags, ...rest } = payload;
  return rest;
}

/**
 * Maneja todas las interacciones de Discord. Funciona igual con interacciones reales de discord.js
 * y con las simuladas del simulador (misma interfaz), así que lo que se prueba en el simulador es lo real.
 */
class InteractionHandler {
  constructor({ engine, config, log }) {
    this.engine = engine;
    this.store = engine.store;
    this.config = config;
    this.log = log;
    this.cooldown = new Cooldown();
    this.active = new Set();
    this.stopped = false;
  }

  // ─── Utilidades ────────────────────────────────────────────────
  userOf(i) {
    const u = i.user;
    let avatar = null;
    try {
      avatar = typeof u.displayAvatarURL === 'function' ? u.displayAvatarURL({ size: 128, extension: 'png' }) : u.avatar || null;
    } catch {
      avatar = null;
    }
    return {
      id: u.id,
      username: u.username,
      displayName: i.member?.displayName || i.member?.nick || u.globalName || u.username,
      avatar,
    };
  }

  isOwner(i) {
    return (this.config?.discord?.ownerIds || []).includes(i.user.id);
  }

  isAdmin(i) {
    if (this.isOwner(i)) return true;
    const p = i.memberPermissions;
    return Boolean(p && (p.has(PermissionFlagsBits.ManageGuild) || p.has(PermissionFlagsBits.Administrator)));
  }

  isStaff(i, settings) {
    if (this.isAdmin(i)) return true;
    const roleId = settings?.staffRoleId;
    if (!roleId) return false;
    const roles = i.member?.roles;
    if (Array.isArray(roles)) return roles.includes(roleId);
    return Boolean(roles?.cache?.has?.(roleId));
  }

  requireStaff(i, settings) {
    if (!this.isStaff(i, settings)) throw new UserError('This action is for staff only (**Manage Server** permission or the configured staff role).', 'FORBIDDEN');
  }

  requireAdmin(i) {
    if (!this.isAdmin(i)) throw new UserError('You need **Manage Server** permission to change settings.', 'FORBIDDEN');
  }

  hit(i, key, ms) {
    const wait = this.cooldown.hit(`${key}:${i.user.id}`, ms);
    if (wait) throw new UserError(`Wait ${Math.ceil(wait / 1000)} seconds before trying again.`, 'COOLDOWN');
  }

  async deferEphemeral(i) {
    if (!i.deferred && !i.replied) await i.deferReply({ flags: ui.EPHEMERAL });
  }

  async respond(i, payload) {
    if (i.deferred || i.replied) return i.editReply(noFlags(payload));
    return i.reply(payload);
  }

  async fail(i, err) {
    let payload;
    if (isUserError(err)) {
      payload = ui.errorMessage(err.message);
    } else if (err?.code === 'BUSY') {
      payload = ui.errorMessage(err.message);
    } else {
      this.log.error('Error manejando una interacción:', err);
      payload = ui.errorMessage('An unexpected error was logged. Please try again shortly.');
    }
    try {
      if (i.isAutocomplete?.()) return;
      if (i.deferred && !i._engUpdate) await i.editReply(noFlags(payload));
      else if (i.deferred || i.replied) await i.followUp(payload);
      else await i.reply(payload);
    } catch (e2) {
      this.log.debug(`No se pudo informar del error al user: ${e2.message}`);
    }
  }

  // ─── Entrada ───────────────────────────────────────────────────
  handle(i) {
    if (this.stopped) return Promise.resolve();
    const job = this._handle(i).finally(() => this.active.delete(job));
    this.active.add(job);
    return job;
  }

  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.active]);
    this.cooldown.cache?.clear();
  }

  async _handle(i) {
    try {
      if (i.isAutocomplete()) return await this.autocomplete(i);
      if (!i.inGuild() || !i.guildId) {
        return await i.reply(ui.errorMessage('This bot only works inside a server.'));
      }
      if (i.isChatInputCommand()) return await this.command(i);
      if (i.isButton()) return await this.button(i);
      if (i.isModalSubmit()) return await this.modal(i);
    } catch (err) {
      await this.fail(i, err);
    }
    return undefined;
  }

  async autocomplete(i) {
    try {
      const focused = i.options.getFocused(true);
      if (focused.name !== 'task' || !i.guildId) return await i.respond([]);
      const q = String(focused.value || '')
        .replace('#', '')
        .trim()
        .toLowerCase();
      const withClosed = i.commandName === 'task' && i.options.getSubcommand(false) === 'status';
      const tasks = withClosed ? this.store.listTasks(i.guildId, { limit: 25 }).items : this.store.activeTasks(i.guildId);
      const choices = tasks
        .filter((t) => !q || String(t.id).startsWith(q) || String(t.tweet?.author?.handle || '').toLowerCase().includes(q) || String(t.tweet?.text || '').toLowerCase().includes(q))
        .slice(0, 25)
        .map((t) => ({
          name: truncate(`#${t.id} · @${t.tweet?.author?.handle || '?'} · ${String(t.tweet?.text || '').replace(/\s+/g, ' ')}${t.status !== 'active' ? ' (closed)' : ''}`, 100),
          value: t.id,
        }));
      await i.respond(choices);
    } catch (err) {
      this.log.debug(`Autocompletedo falló: ${err.message}`);
      try {
        await i.respond([]);
      } catch {
        /* la interacción caducó */
      }
    }
  }

  // ─── Comandos ──────────────────────────────────────────────────
  async command(i) {
    const g = i.guildId;
    const settings = this.store.getSettings(g);
    switch (i.commandName) {
      case 'link':
        return this.startLink(i, i.options.getString('user', true));
      case 'unlink': {
        const ok = this.engine.links.unlink(i.user.id, { guildId: g, actor: { id: i.user.id, name: i.user.username } });
        return i.reply(ok ? ui.successMessage('Your X account was unlinked. Link another with `/link`.') : ui.infoMessage('You did not have a linked X account.'));
      }
      case 'profile':
        return this.profile(i);
      case 'tasks':
        return this.taskList(i);
      case 'verify':
        return this.verifyCommand(i);
      case 'proof':
        return this.proof(i);
      case 'ranking':
        return this.ranking(i);
      case 'help':
        return i.reply(ui.helpMessage({ staff: this.isStaff(i, settings) }));
      case 'task':
        return this.taskCommand(i, settings);
      case 'member':
        return this.memberCommand(i, settings);
      case 'config':
        return this.configCommand(i, settings);
      case 'points':
        this.requireAdmin(i);
        return this.savePoints(i);
      default:
        return i.reply(ui.errorMessage('Unknown command. If the bot was just updated, allow Discord to refresh its commands.'));
    }
  }

  async startLink(i, handleInput) {
    this.hit(i, 'linkstart', 3000);
    const settings = this.store.getSettings(i.guildId);
    const user = this.userOf(i);
    this.store.touchMember(i.guildId, user);
    const current = this.store.getLink(user.id);
    const wanted = String(handleInput || '').replace(/^@/, '').toLowerCase();
    if (current?.verified && current.handle.toLowerCase() === wanted) {
      return this.respond(i, ui.infoMessage(`You have already linked and verified **@${current.handle}**. ✅`, { title: 'Account already linked' }));
    }
    const start = this.engine.links.start(user, i.guildId, handleInput);
    return this.respond(
      i,
      ui.linkStartMessage({
        handle: start.handle,
        code: start.code,
        tweetIntent: start.tweetIntent,
        expiresAt: start.request.expiresAt,
        allowUnverified: !settings.verification.requireVerifiedLink,
      }),
    );
  }

  async profile(i) {
    const target = i.options.getUser('member') || i.user;
    const g = i.guildId;
    const member = target.id === i.user.id ? this.store.touchMember(g, this.userOf(i)) : this.store.getMember(g, target.id);
    const link = this.store.getLink(target.id);
    const rank = this.store.rankOf(g, target.id);
    const info =
      target.id === i.user.id
        ? this.userOf(i)
        : { id: target.id, username: target.username, displayName: target.globalName || target.username, avatar: typeof target.displayAvatarURL === 'function' ? target.displayAvatarURL({ size: 128 }) : null };
    return i.reply(ui.profileMessage({ user: info, member, link, rank }));
  }

  async taskList(i) {
    const tasks = this.store.activeTasks(i.guildId);
    const done = this.store.completedTaskIds(
      i.user.id,
      tasks.map((t) => t.id),
    );
    return i.reply(ui.taskListMessage(tasks, { guildId: i.guildId, completedBy: new Map([...done].map((id) => [id, true])) }));
  }

  async ranking(i) {
    const periodo = i.options.getString('period') || 'all';
    const since = periodo === 'week' ? Date.now() - 7 * 86400_000 : periodo === 'month' ? Date.now() - 30 * 86400_000 : 0;
    const rows = this.store.leaderboard(i.guildId, { sinceMs: since, limit: 10 });
    const title = { week: 'Leaderboard · last 7 days', month: 'Leaderboard · last 30 days', all: 'All-time leaderboard' }[periodo];
    return i.reply(ui.ephemeral(ui.leaderboardMessage(rows, { title, guildName: i.guild?.name })));
  }

  // ─── Verificación ──────────────────────────────────────────────
  /** Decide qué tarea verificar cuando el usuario no indica ninguna. */
  pickTask(i) {
    const id = i.options.getInteger('task');
    if (id) return this.engine.tasks.get(i.guildId, id);
    const active = this.store.activeTasks(i.guildId);
    const done = this.store.completedTaskIds(
      i.user.id,
      active.map((t) => t.id),
    );
    const open = active.filter((t) => !done.has(t.id));
    if (open.length === 1) return open[0];
    if (open.length === 0) throw new UserError(active.length ? 'You have completed all active tasks! 🎉' : 'No active tasks right now.', 'NO_TASKS');
    throw new UserError(`You have ${open.length} pending tasks: choose one with the \`task\` (${open.map((t) => `#${t.id}`).join(', ')}).`, 'AMBIGUOUS');
  }

  async verifyCommand(i) {
    const task = this.pickTask(i);
    const inputs = {};
    const c = i.options.getString('reply');
    const q = i.options.getString('quote');
    if (c) inputs.reply = c;
    if (q) inputs.quote = q;
    return this.startVerify(i, task, inputs);
  }

  /** Comprobaciones rápidas (sin red) antes de abrir el formulario o verificar. */
  async startVerify(i, task, inputs = {}) {
    const settings = this.store.getSettings(i.guildId);
    if (!this.engine.tasks.isOpen(task)) {
      return this.respond(i, ui.infoMessage(`Task #${task.id} has ended. Watch for the next one! 👀`, { title: '⏰ Task finished' }));
    }
    const link = this.store.getLink(i.user.id);
    const v = settings.verification;
    if (v.requireLink && !link) return this.respond(i, ui.needLinkMessage(false));
    if (v.requireLink && v.requireVerifiedLink && !link.verified) return this.respond(i, ui.needLinkMessage(true));
    this.hit(i, 'verify', 3000);

    const needed = this.engine.verification.neededInputs(task, i.user.id).filter((a) => !inputs[a]);
    if (needed.length) return i.showModal(ui.verifyModal(task, needed));
    await this.deferEphemeral(i);
    return this.runVerify(i, task, inputs);
  }

  async runVerify(i, task, inputs) {
    const user = this.userOf(i);
    const r = await this.engine.verification.verify({ task, user, inputs });
    const points = this.store.taskPointsFor(task.id, user.id);
    return this.respond(i, ui.progressMessage(task, r.progress, { results: r.results, completedNow: r.completedNow, pointsEarned: points }));
  }

  async proof(i) {
    const task = this.engine.tasks.get(i.guildId, i.options.getInteger('task', true));
    const action = i.options.getString('action', true);
    const att = i.options.getAttachment('image', true);
    this.hit(i, 'proof', 5000);
    await this.deferEphemeral(i);
    const r = await this.engine.verification.submitProof({
      task,
      user: this.userOf(i),
      action,
      attachment: { url: att.url, contentType: att.contentType, size: att.size, name: att.name, buffer: att.buffer },
    });
    const label = `${ACTION_INFO[action].emoji} ${ACTION_INFO[action].label}`;
    return this.respond(
      i,
      r.autoApproved
        ? ui.successMessage(`Screenshot received and **approved automatically** based on your trust level (${label}, task #${task.id}).`, { title: 'Evidence accepted' })
        : ui.infoMessage(`Screenshot received for **${label}** on task #${task.id}. Staff will review it and notify you.`, { title: '🕓 Evidence submitted', color: ui.COLORS.warn }),
    );
  }

  // ─── Comandos de staff ─────────────────────────────────────────
  async taskCommand(i, settings) {
    const sub = i.options.getSubcommand();
    this.requireStaff(i, settings);
    const actor = { id: i.user.id, name: i.user.username };
    const g = i.guildId;

    if (sub === 'create') {
      const picks = { like: i.options.getBoolean('like'), repost: i.options.getBoolean('repost'), reply: i.options.getBoolean('reply'), quote: i.options.getBoolean('quote') };
      const anyGiven = Object.values(picks).some((v) => v !== null);
      const actions = anyGiven ? Object.keys(picks).filter((k) => picks[k]) : undefined;
      if (anyGiven && !actions.length) throw new UserError('Set at least one action (like, repost, reply or quote) to `true`.', 'NO_ACTIONS');
      await this.deferEphemeral(i);
      const participants = i.options.getRole('participants');
      const mention = i.options.getRole('mention');
      const channel = i.options.getChannel('channel');
      const points = {};
      for (const action of ['like', 'repost', 'reply', 'quote', 'bonus']) {
        const value = i.options.getInteger(`${action}-points`);
        if (value !== null) points[action] = value;
      }
      const multiplier = i.options.getNumber('multiplier');
      if (multiplier !== null && Object.keys(points).length) throw new UserError('Choose individual point values or a multiplier for this post.');
      const task = await this.engine.tasks.create({
        guildId: g,
        tweetUrl: i.options.getString('url', true),
        actions,
        duration: i.options.getString('duration') || undefined,
        pointsMultiplier: multiplier || undefined,
        points: Object.keys(points).length ? points : undefined,
        channelId: channel?.id,
        roleId: participants ? participants.id : undefined,
        pingRoleId: mention ? mention.id : undefined,
        note: i.options.getString('note') || undefined,
        createdBy: actor,
      });
      const url = ui.messageUrl(g, task.channelId, task.messageId);
      return this.respond(
        i,
        ui.ephemeral({
          embeds: [
            ui.embed({
              color: ui.COLORS.ok,
              title: `✅ Task #${task.id} published`,
              description: `In <#${task.channelId}> · ${ui.actionsLine(task.actions)}\nEnds ${discordTs(task.endsAt, 'R')} (${formatDuration((task.endsAt - task.createdAt) / 60000)}).`,
            }),
          ],
          components: url ? [ui.row(ui.button({ label: 'View task', emoji: '🚀', url }))] : [],
        }),
      );
    }

    const task = this.engine.tasks.get(g, i.options.getInteger('task', true));
    if (sub === 'status') {
      await this.deferEphemeral(i);
      return this.respond(i, ui.statusMessage(task, await this.engine.tasks.summary(task)));
    }
    if (sub === 'close') {
      await this.deferEphemeral(i);
      const s = await this.engine.tasks.close(g, task.id, { actor });
      return this.respond(
        i,
        ui.successMessage(`Task #${task.id} closed. **${s.completed.length}** completed and **${s.notCompletedCount}** did not. The report was posted in the channel.`, { title: 'Task closed' }),
      );
    }
    if (sub === 'cancel') {
      await this.engine.tasks.cancel(g, task.id, { actor });
      return i.reply(ui.successMessage(`Task #${task.id} cancelled.`, { title: 'Task cancelled' }));
    }
    if (sub === 'remind') {
      await this.deferEphemeral(i);
      const r = await this.engine.tasks.remind(g, task.id, { actor });
      return this.respond(i, ui.successMessage(r.targets ? `Reminder sent to **${r.targets}** members.` : 'Everyone has completed the task. 🎉', { title: 'Reminder' }));
    }
    if (sub === 'extend') {
      const t = await this.engine.tasks.extend(g, task.id, i.options.getString('time', true), { actor });
      return i.reply(ui.successMessage(`Task #${t.id} now ends ${discordTs(t.endsAt, 'R')}.`, { title: 'Task extended' }));
    }
    throw new UserError('Unknown subcommand.');
  }

  async memberCommand(i, settings) {
    this.requireStaff(i, settings);
    const sub = i.options.getSubcommand();
    const target = i.options.getUser('user', true);
    const g = i.guildId;
    const actor = { id: i.user.id, name: i.user.username };
    if (target.bot) throw new UserError('This command cannot be used with bots.');
    this.store.touchMember(g, { id: target.id, username: target.username, displayName: target.globalName || target.username });

    if (sub === 'points') {
      const amount = i.options.getInteger('amount', true);
      const reason = i.options.getString('reason') || 'Manual adjustment';
      if (!amount) throw new UserError('The amount cannot be 0.');
      this.store.addLedger({ guildId: g, userId: target.id, kind: 'manual', amount, reason });
      this.engine.tasks.audit(g, 'points', actor, `${amount > 0 ? '+' : ''}${amount} points for <@${target.id}> (${reason})`, { userId: target.id });
      this.engine.bus.change(g, 'member', { userId: target.id });
      const m = this.store.getMember(g, target.id);
      return i.reply(ui.successMessage(`<@${target.id}> now has **${fmtNum(m.points)}** points.`, { title: 'Points updated' }));
    }
    if (sub === 'block' || sub === 'unblock') {
      const block = sub === 'block';
      this.store.updateMember(g, target.id, { blacklisted: block });
      this.engine.tasks.audit(g, 'member', actor, `<@${target.id}> ${block ? 'blocked' : 'unblocked'} from tasks`, { userId: target.id });
      this.engine.bus.change(g, 'member', { userId: target.id });
      return i.reply(ui.successMessage(`<@${target.id}> ${block ? 'can no longer' : 'can now'} participate in tasks.`));
    }
    if (sub === 'link') {
      const link = this.engine.links.adminLink({ userId: target.id, handleInput: i.options.getString('account', true), guildId: g, actor });
      return i.reply(ui.successMessage(`<@${target.id}> linked to **@${link.handle}** (verified by staff).`));
    }
    if (sub === 'unlink') {
      const ok = this.engine.links.unlink(target.id, { guildId: g, actor });
      return i.reply(ok ? ui.successMessage(`Unlinked the X account for <@${target.id}>.`) : ui.infoMessage('That member did not have a linked account.'));
    }
    throw new UserError('Unknown subcommand.');
  }

  async configCommand(i, settings) {
    this.requireAdmin(i);
    const sub = i.options.getSubcommand();
    const actor = { id: i.user.id, name: i.user.username };
    let patch = null;
    switch (sub) {
      case 'view':
        return i.reply(ui.configMessage(settings));
      case 'channel':
        patch = { tasksChannelId: i.options.getChannel('channel', true).id };
        break;
      case 'logs':
        patch = { logChannelId: i.options.getChannel('channel')?.id || null };
        break;
      case 'participant-role':
        patch = { participantRoleId: i.options.getRole('role')?.id || null };
        break;
      case 'staff-role':
        patch = { staffRoleId: i.options.getRole('role')?.id || null };
        break;
      case 'mention-role':
        patch = { pingRoleId: i.options.getRole('role')?.id || null };
        break;
      case 'verification':
        patch = { verification: { proofMode: i.options.getString('mode', true) } };
        break;
      case 'quality':
        patch = { verification: { minReplyQuality: i.options.getInteger('minimum', true) } };
        break;
      case 'reminders': {
        const r = { enabled: i.options.getBoolean('enabled', true) };
        const m = i.options.getInteger('minutes');
        const mode = i.options.getString('mode');
        if (m) r.minutesBefore = m;
        if (mode) r.mode = mode;
        patch = { reminders: r };
        break;
      }
      case 'points':
        return this.savePoints(i);
      case 'duration': {
        const d = parseDuration(i.options.getString('time', true));
        if (!d) throw new UserError('Invalid duration. Examples: `45m`, `2h`, `1d`.');
        patch = { defaultDurationMinutes: d };
        break;
      }
      default:
        throw new UserError('Unknown subcommand.');
    }
    const updated = this.engine.updateSettings(i.guildId, patch, actor);
    return i.reply(ui.configMessage(updated));
  }

  async savePoints(i) {
    const points = {};
    for (const action of ['like', 'repost', 'reply', 'quote', 'bonus']) {
      const value = i.options.getInteger(action);
      if (value !== null) points[action] = value;
    }
    if (!Object.keys(points).length) throw new UserError('Provide at least one point value.');
    const updated = this.engine.updateSettings(i.guildId, { points }, { id: i.user.id, name: i.user.username });
    return i.reply(ui.configMessage(updated));
  }

  // ─── Botones ───────────────────────────────────────────────────
  async button(i) {
    const parts = String(i.customId).split(':');
    if (parts[0] !== 'eng') return undefined;
    const [, kind, a, b] = parts;
    const g = i.guildId;

    if (kind === 'verify') return this.startVerify(i, this.engine.tasks.get(g, Number(a)));
    if (kind === 'progress') {
      const task = this.engine.tasks.get(g, Number(a));
      const progress = this.engine.tasks.progress(task, i.user.id);
      return i.reply(ui.progressMessage(task, progress, { pointsEarned: this.store.taskPointsFor(task.id, i.user.id) }));
    }
    if (kind === 'status') {
      const task = this.engine.tasks.get(g, Number(a));
      const settings = this.store.getSettings(g);
      if (!settings.publicStatus) this.requireStaff(i, settings);
      this.hit(i, 'status', 4000);
      await this.deferEphemeral(i);
      return this.respond(i, ui.statusMessage(task, await this.engine.tasks.summary(task)));
    }
    if (kind === 'link') {
      if (a === 'start') {
        const link = this.store.getLink(i.user.id);
        if (link && !link.verified) return this.startLink(i, link.handle);
        return i.showModal(ui.linkStartModal());
      }
      if (a === 'bio') {
        this.hit(i, 'linkverify', 5000);
        await this.deferEphemeral(i);
        const link = await this.engine.links.verifyBio(this.userOf(i));
        return this.respond(i, ui.linkedMessage(link));
      }
      if (a === 'tweet') return i.showModal(ui.linkTweetModal());
      if (a === 'skip') {
        const settings = this.store.getSettings(g);
        if (settings.verification.requireVerifiedLink) throw new UserError('This server requires account verification.');
        const req = this.store.getLinkRequest(i.user.id);
        if (!req) throw new UserError('You have no pending link request. Use `/link`.');
        const link = this.engine.links.linkUnverified(this.userOf(i), g, req.handle);
        return i.reply(ui.linkedMessage(link));
      }
    }
    if (kind === 'rev') {
      const settings = this.store.getSettings(g);
      this.requireStaff(i, settings);
      if (a === 'ok') {
        const r = this.engine.verification.review(g, Number(b), { approve: true, reviewer: { id: i.user.id, name: i.user.username } });
        return i.update(noFlags(this.decidedReview(i, r)));
      }
      if (a === 'no') return i.showModal(ui.rejectModal(Number(b)));
    }
    throw new UserError('This button is no longer valid.');
  }

  decidedReview(i, r) {
    const oldImage = i.message?.embeds?.[0]?.image?.url || i.message?.embeds?.[0]?.data?.image?.url || null;
    const link = this.store.getLink(r.submission.userId);
    return ui.reviewMessage(r.task, r.submission, { xHandle: link?.handle }, oldImage, { decided: r.decided });
  }

  // ─── Formularios (modales) ─────────────────────────────────────
  async modal(i) {
    const parts = String(i.customId).split(':');
    if (parts[0] !== 'eng' || parts[1] !== 'm') return undefined;
    const [, , kind, a] = parts;
    const g = i.guildId;
    const val = (id) => {
      try {
        return i.fields.getTextInputValue(id);
      } catch {
        return '';
      }
    };

    if (kind === 'verify') {
      const task = this.engine.tasks.get(g, Number(a));
      const inputs = {};
      if (val('reply')) inputs.reply = val('reply').trim();
      if (val('quote')) inputs.quote = val('quote').trim();
      await this.deferEphemeral(i);
      if (!this.engine.tasks.isOpen(task)) throw new UserError(`Task #${task.id} ended while you were filling out the form.`);
      return this.runVerify(i, task, inputs);
    }
    if (kind === 'linkstart') return this.startLink(i, val('handle'));
    if (kind === 'linktweet') {
      this.hit(i, 'linkverify', 5000);
      await this.deferEphemeral(i);
      const link = await this.engine.links.verifyTweet(this.userOf(i), val('url'));
      return this.respond(i, ui.linkedMessage(link));
    }
    if (kind === 'reject') {
      const settings = this.store.getSettings(g);
      this.requireStaff(i, settings);
      const reason = val('reason').trim() || null;
      const r = this.engine.verification.review(g, Number(a), { approve: false, reviewer: { id: i.user.id, name: i.user.username }, reason });
      const payload = noFlags(this.decidedReview(i, r));
      if (typeof i.isFromMessage === 'function' && i.isFromMessage()) {
        i._engUpdate = true;
        return i.update(payload);
      }
      return i.reply(ui.successMessage('Submission rejected.'));
    }
    throw new UserError('Unknown form.');
  }
}

module.exports = { InteractionHandler, noFlags };
