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
  }

  get dashboardUrl() {
    return this.config?.web?.enabled ? this.config.web.publicUrl : null;
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
    if (!this.isStaff(i, settings)) throw new UserError('Esta acción es sólo para el staff (permiso **Gestionar servidor** o el rol de staff configurado).', 'FORBIDDEN');
  }

  requireAdmin(i) {
    if (!this.isAdmin(i)) throw new UserError('Necesitas el permiso **Gestionar servidor** para cambiar la configuración.', 'FORBIDDEN');
  }

  hit(i, key, ms) {
    const wait = this.cooldown.hit(`${key}:${i.user.id}`, ms);
    if (wait) throw new UserError(`Espera ${Math.ceil(wait / 1000)} s antes de volver a intentarlo.`, 'COOLDOWN');
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
      payload = ui.errorMessage('Ocurrió un error inesperado. Quedó registrado; inténtalo de nuevo en un momento.');
    }
    try {
      if (i.isAutocomplete?.()) return;
      if (i.deferred && !i._engUpdate) await i.editReply(noFlags(payload));
      else if (i.deferred || i.replied) await i.followUp(payload);
      else await i.reply(payload);
    } catch (e2) {
      this.log.debug(`No se pudo informar del error al usuario: ${e2.message}`);
    }
  }

  // ─── Entrada ───────────────────────────────────────────────────
  async handle(i) {
    try {
      if (i.isAutocomplete()) return await this.autocomplete(i);
      if (!i.inGuild() || !i.guildId) {
        return await i.reply(ui.errorMessage('Este bot sólo funciona dentro de un servidor.'));
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
      if (focused.name !== 'tarea' || !i.guildId) return await i.respond([]);
      const q = String(focused.value || '')
        .replace('#', '')
        .trim()
        .toLowerCase();
      const withClosed = i.commandName === 'tarea' && i.options.getSubcommand(false) === 'estado';
      const tasks = withClosed ? this.store.listTasks(i.guildId, { limit: 25 }).items : this.store.activeTasks(i.guildId);
      const choices = tasks
        .filter((t) => !q || String(t.id).startsWith(q) || String(t.tweet?.author?.handle || '').toLowerCase().includes(q) || String(t.tweet?.text || '').toLowerCase().includes(q))
        .slice(0, 25)
        .map((t) => ({
          name: truncate(`#${t.id} · @${t.tweet?.author?.handle || '?'} · ${String(t.tweet?.text || '').replace(/\s+/g, ' ')}${t.status !== 'active' ? ' (cerrada)' : ''}`, 100),
          value: t.id,
        }));
      await i.respond(choices);
    } catch (err) {
      this.log.debug(`Autocompletado falló: ${err.message}`);
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
      case 'vincular':
        return this.startLink(i, i.options.getString('usuario', true));
      case 'desvincular': {
        const ok = this.engine.links.unlink(i.user.id, { guildId: g, actor: { id: i.user.id, name: i.user.username } });
        return i.reply(ok ? ui.successMessage('Tu cuenta de X se desvinculó. Puedes vincular otra con `/vincular`.') : ui.infoMessage('No tenías ninguna cuenta de X vinculada.'));
      }
      case 'perfil':
        return this.profile(i);
      case 'tareas':
        return this.taskList(i);
      case 'verificar':
        return this.verifyCommand(i);
      case 'prueba':
        return this.proof(i);
      case 'ranking':
        return this.ranking(i);
      case 'ayuda':
        return i.reply(ui.helpMessage({ staff: this.isStaff(i, settings), dashboardUrl: this.dashboardUrl }));
      case 'panel': {
        this.requireStaff(i, settings);
        if (!this.dashboardUrl) return i.reply(ui.infoMessage('El panel web está desactivado en la configuración del bot.'));
        return i.reply(
          ui.ephemeral({
            embeds: [ui.embed({ color: ui.COLORS.info, title: '🖥️ Panel web de control', description: `Gestiona tareas, miembros, revisiones y ajustes desde:\n${this.dashboardUrl}` })],
            components: [ui.row(ui.button({ label: 'Abrir panel', emoji: '🖥️', url: this.dashboardUrl }))],
          }),
        );
      }
      case 'tarea':
        return this.taskCommand(i, settings);
      case 'miembro':
        return this.memberCommand(i, settings);
      case 'config':
        return this.configCommand(i, settings);
      default:
        return i.reply(ui.errorMessage('Comando desconocido. Si acabas de actualizar el bot, espera a que Discord refresque los comandos.'));
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
      return this.respond(i, ui.infoMessage(`Ya tienes vinculada y verificada la cuenta **@${current.handle}**. ✅`, { title: 'Cuenta ya vinculada' }));
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
    const target = i.options.getUser('miembro') || i.user;
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
    const periodo = i.options.getString('periodo') || 'todo';
    const since = periodo === 'semana' ? Date.now() - 7 * 86400_000 : periodo === 'mes' ? Date.now() - 30 * 86400_000 : 0;
    const rows = this.store.leaderboard(i.guildId, { sinceMs: since, limit: 10 });
    const title = { semana: 'Ranking · últimos 7 días', mes: 'Ranking · últimos 30 días', todo: 'Ranking general' }[periodo];
    return i.reply(ui.ephemeral(ui.leaderboardMessage(rows, { title, guildName: i.guild?.name })));
  }

  // ─── Verificación ──────────────────────────────────────────────
  /** Decide qué tarea verificar cuando el usuario no indica ninguna. */
  pickTask(i) {
    const id = i.options.getInteger('tarea');
    if (id) return this.engine.tasks.get(i.guildId, id);
    const active = this.store.activeTasks(i.guildId);
    const done = this.store.completedTaskIds(
      i.user.id,
      active.map((t) => t.id),
    );
    const open = active.filter((t) => !done.has(t.id));
    if (open.length === 1) return open[0];
    if (open.length === 0) throw new UserError(active.length ? '¡Ya completaste todas las tareas activas! 🎉' : 'No hay tareas activas ahora mismo.', 'NO_TASKS');
    throw new UserError(`Tienes ${open.length} tareas pendientes: indica cuál con la opción \`tarea\` (${open.map((t) => `#${t.id}`).join(', ')}).`, 'AMBIGUOUS');
  }

  async verifyCommand(i) {
    const task = this.pickTask(i);
    const inputs = {};
    const c = i.options.getString('comentario');
    const q = i.options.getString('cita');
    if (c) inputs.reply = c;
    if (q) inputs.quote = q;
    return this.startVerify(i, task, inputs);
  }

  /** Comprobaciones rápidas (sin red) antes de abrir el formulario o verificar. */
  async startVerify(i, task, inputs = {}) {
    const settings = this.store.getSettings(i.guildId);
    if (!this.engine.tasks.isOpen(task)) {
      return this.respond(i, ui.infoMessage(`La tarea #${task.id} ya terminó. ¡Atento a la próxima! 👀`, { title: '⏰ Tarea finalizada' }));
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
    const task = this.engine.tasks.get(i.guildId, i.options.getInteger('tarea', true));
    const action = i.options.getString('accion', true);
    const att = i.options.getAttachment('imagen', true);
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
        ? ui.successMessage(`Captura recibida y **aprobada automáticamente** por tu nivel de confianza (${label}, tarea #${task.id}).`, { title: 'Prueba aceptada' })
        : ui.infoMessage(`Captura recibida para **${label}** en la tarea #${task.id}. El staff la revisará pronto y te avisaré.`, { title: '🕓 Prueba enviada', color: ui.COLORS.warn }),
    );
  }

  // ─── Comandos de staff ─────────────────────────────────────────
  async taskCommand(i, settings) {
    const sub = i.options.getSubcommand();
    this.requireStaff(i, settings);
    const actor = { id: i.user.id, name: i.user.username };
    const g = i.guildId;

    if (sub === 'crear') {
      const picks = { like: i.options.getBoolean('like'), repost: i.options.getBoolean('repost'), reply: i.options.getBoolean('comentario'), quote: i.options.getBoolean('cita') };
      const anyGiven = Object.values(picks).some((v) => v !== null);
      const actions = anyGiven ? Object.keys(picks).filter((k) => picks[k]) : undefined;
      if (anyGiven && !actions.length) throw new UserError('Marca al menos una acción (like, repost, comentario o cita) en `true`.', 'NO_ACTIONS');
      await this.deferEphemeral(i);
      const participants = i.options.getRole('participantes');
      const mention = i.options.getRole('mencionar');
      const channel = i.options.getChannel('canal');
      const task = await this.engine.tasks.create({
        guildId: g,
        tweetUrl: i.options.getString('enlace', true),
        actions,
        duration: i.options.getString('duracion') || undefined,
        pointsMultiplier: i.options.getNumber('multiplicador') || undefined,
        channelId: channel?.id,
        roleId: participants ? participants.id : undefined,
        pingRoleId: mention ? mention.id : undefined,
        note: i.options.getString('nota') || undefined,
        createdBy: actor,
      });
      const url = ui.messageUrl(g, task.channelId, task.messageId);
      return this.respond(
        i,
        ui.ephemeral({
          embeds: [
            ui.embed({
              color: ui.COLORS.ok,
              title: `✅ Tarea #${task.id} publicada`,
              description: `En <#${task.channelId}> · ${ui.actionsLine(task.actions)}\nTermina ${discordTs(task.endsAt, 'R')} (${formatDuration((task.endsAt - task.createdAt) / 60000)}).`,
            }),
          ],
          components: url ? [ui.row(ui.button({ label: 'Ver tarea', emoji: '🚀', url }))] : [],
        }),
      );
    }

    const task = this.engine.tasks.get(g, i.options.getInteger('tarea', true));
    if (sub === 'estado') {
      await this.deferEphemeral(i);
      return this.respond(i, ui.statusMessage(task, await this.engine.tasks.summary(task)));
    }
    if (sub === 'cerrar') {
      await this.deferEphemeral(i);
      const s = await this.engine.tasks.close(g, task.id, { actor });
      return this.respond(
        i,
        ui.successMessage(`Tarea #${task.id} cerrada. **${s.completed.length}** completaron y **${s.notCompletedCount}** no. El informe se publicó en el canal.`, { title: 'Tarea cerrada' }),
      );
    }
    if (sub === 'cancelar') {
      await this.engine.tasks.cancel(g, task.id, { actor });
      return i.reply(ui.successMessage(`Tarea #${task.id} cancelada.`, { title: 'Tarea cancelada' }));
    }
    if (sub === 'recordar') {
      await this.deferEphemeral(i);
      const r = await this.engine.tasks.remind(g, task.id, { actor });
      return this.respond(i, ui.successMessage(r.targets ? `Recordatorio enviado a **${r.targets}** miembros.` : 'Nadie tiene la tarea pendiente. 🎉', { title: 'Recordatorio' }));
    }
    if (sub === 'extender') {
      const t = await this.engine.tasks.extend(g, task.id, i.options.getString('tiempo', true), { actor });
      return i.reply(ui.successMessage(`La tarea #${t.id} ahora termina ${discordTs(t.endsAt, 'R')}.`, { title: 'Tarea extendida' }));
    }
    throw new UserError('Subcomando desconocido.');
  }

  async memberCommand(i, settings) {
    this.requireStaff(i, settings);
    const sub = i.options.getSubcommand();
    const target = i.options.getUser('usuario', true);
    const g = i.guildId;
    const actor = { id: i.user.id, name: i.user.username };
    if (target.bot) throw new UserError('No se puede usar con bots.');
    this.store.touchMember(g, { id: target.id, username: target.username, displayName: target.globalName || target.username });

    if (sub === 'puntos') {
      const amount = i.options.getInteger('cantidad', true);
      const reason = i.options.getString('motivo') || 'Ajuste manual';
      if (!amount) throw new UserError('La cantidad no puede ser 0.');
      this.store.addLedger({ guildId: g, userId: target.id, kind: 'manual', amount, reason });
      this.engine.tasks.audit(g, 'points', actor, `${amount > 0 ? '+' : ''}${amount} puntos a <@${target.id}> (${reason})`, { userId: target.id });
      this.engine.bus.change(g, 'member', { userId: target.id });
      const m = this.store.getMember(g, target.id);
      return i.reply(ui.successMessage(`<@${target.id}> ahora tiene **${fmtNum(m.points)}** puntos.`, { title: 'Puntos actualizados' }));
    }
    if (sub === 'bloquear' || sub === 'desbloquear') {
      const block = sub === 'bloquear';
      this.store.updateMember(g, target.id, { blacklisted: block });
      this.engine.tasks.audit(g, 'member', actor, `<@${target.id}> ${block ? 'bloqueado' : 'desbloqueado'} para tareas`, { userId: target.id });
      this.engine.bus.change(g, 'member', { userId: target.id });
      return i.reply(ui.successMessage(`<@${target.id}> ${block ? 'ya no puede' : 'vuelve a poder'} participar en tareas.`));
    }
    if (sub === 'vincular') {
      const link = this.engine.links.adminLink({ userId: target.id, handleInput: i.options.getString('cuenta', true), guildId: g, actor });
      return i.reply(ui.successMessage(`<@${target.id}> vinculado a **@${link.handle}** (verificado por el staff).`));
    }
    if (sub === 'desvincular') {
      const ok = this.engine.links.unlink(target.id, { guildId: g, actor });
      return i.reply(ok ? ui.successMessage(`Se quitó la cuenta de X de <@${target.id}>.`) : ui.infoMessage('Ese miembro no tenía cuenta vinculada.'));
    }
    throw new UserError('Subcomando desconocido.');
  }

  async configCommand(i, settings) {
    this.requireAdmin(i);
    const sub = i.options.getSubcommand();
    const actor = { id: i.user.id, name: i.user.username };
    let patch = null;
    switch (sub) {
      case 'ver':
        return i.reply(ui.configMessage(settings, { dashboardUrl: this.dashboardUrl }));
      case 'canal':
        patch = { tasksChannelId: i.options.getChannel('canal', true).id };
        break;
      case 'logs':
        patch = { logChannelId: i.options.getChannel('canal')?.id || null };
        break;
      case 'rol-participantes':
        patch = { participantRoleId: i.options.getRole('rol')?.id || null };
        break;
      case 'rol-staff':
        patch = { staffRoleId: i.options.getRole('rol')?.id || null };
        break;
      case 'rol-mencion':
        patch = { pingRoleId: i.options.getRole('rol')?.id || null };
        break;
      case 'verificacion':
        patch = { verification: { proofMode: i.options.getString('modo', true) } };
        break;
      case 'calidad':
        patch = { verification: { minReplyQuality: i.options.getInteger('minimo', true) } };
        break;
      case 'recordatorios': {
        const r = { enabled: i.options.getBoolean('activar', true) };
        const m = i.options.getInteger('minutos');
        const mode = i.options.getString('modo');
        if (m) r.minutesBefore = m;
        if (mode) r.mode = mode;
        patch = { reminders: r };
        break;
      }
      case 'puntos': {
        const p = {};
        for (const [opt, key] of [
          ['like', 'like'],
          ['repost', 'repost'],
          ['comentario', 'reply'],
          ['cita', 'quote'],
          ['bonus', 'bonus'],
        ]) {
          const v = i.options.getInteger(opt);
          if (v !== null) p[key] = v;
        }
        if (!Object.keys(p).length) throw new UserError('Indica al menos un valor de puntos.');
        patch = { points: p };
        break;
      }
      case 'duracion': {
        const d = parseDuration(i.options.getString('tiempo', true));
        if (!d) throw new UserError('Duración no válida. Ejemplos: `45m`, `2h`, `1d`.');
        patch = { defaultDurationMinutes: d };
        break;
      }
      default:
        throw new UserError('Subcomando desconocido.');
    }
    const updated = this.engine.updateSettings(i.guildId, patch, actor);
    return i.reply(ui.configMessage(updated, { dashboardUrl: this.dashboardUrl }));
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
        if (settings.verification.requireVerifiedLink) throw new UserError('Este servidor exige verificar la cuenta.');
        const req = this.store.getLinkRequest(i.user.id);
        if (!req) throw new UserError('No tienes ninguna vinculación pendiente. Usa `/vincular`.');
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
    throw new UserError('Este botón ya no es válido.');
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
      if (!this.engine.tasks.isOpen(task)) throw new UserError(`La tarea #${task.id} terminó mientras rellenabas el formulario.`);
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
      return i.reply(ui.successMessage('Envío rechazado.'));
    }
    throw new UserError('Formulario desconocido.');
  }
}

module.exports = { InteractionHandler, noFlags };
