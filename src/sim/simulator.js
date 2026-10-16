'use strict';

const { SimGateway } = require('./gateway');
const { FakeInteraction, SimInteractionError } = require('./interaction');
const { PayloadError } = require('./validate');
const { DiscordPublisher } = require('../discord/publisher');
const { InteractionHandler } = require('../discord/handlers');
const { commandsJSON } = require('../discord/commands');
const { UserError } = require('../core/errors');
const { parseTweetUrl } = require('../twitter/urls');
const { sampleProofPng } = require('./png');

const AVATAR = (n) => `https://cdn.discordapp.com/embed/avatars/${n % 6}.png`;

const MEMBERS = [
  { username: 'ana.staff', name: 'Ana (Staff)', staff: true, x: 'ana_staff_x' },
  { username: 'lucia', name: 'Lucía', x: 'lucia_x' },
  { username: 'mateo', name: 'Mateo', x: 'mateo_x' },
  { username: 'sofia', name: 'Sofía', x: 'sofia_x' },
  { username: 'diego', name: 'Diego', x: 'diego_x' },
  { username: 'valen', name: 'Valentina', x: 'valen_x' },
  { username: 'hugo', name: 'Hugo', x: 'hugo_x' },
  { username: 'camila', name: 'Camila', x: 'camila_x' },
  { username: 'leo', name: 'Leo', x: 'leo_x' },
];

const BRAND_POSTS = [
  '🚀 Hoy lanzamos la versión 2.0 de nuestra app: modo oscuro, sincronización en la nube y un 40% más rápida. ¿Qué función queréis ver en la próxima actualización?',
  '🎮 Torneo comunitario este sábado a las 20:00 (hora de Madrid). Premios para el top 3 y sorteo entre todos los participantes. ¿Quién se apunta?',
  '📢 Estamos contratando: buscamos moderadores para nuestra comunidad hispana. Si te apasiona Discord y las redes, ¡escríbenos!',
];

/**
 * Simulador completo: un servidor de Discord falso + cuentas de X falsas, conectados al motor real.
 * Todo pasa por el mismo código que en producción (InteractionHandler, DiscordPublisher, servicios).
 */
class Simulator {
  constructor({ engine, mock, config, log }) {
    this.engine = engine;
    this.mock = mock;
    this.config = config;
    this.log = log;
    this.gateway = new SimGateway();
    this.pendingModals = new Map();
    this.handler = new InteractionHandler({ engine, config, log: log.child('sim-interacciones') });
    this.publisher = new DiscordPublisher({ gateway: this.gateway, store: engine.store, log: log.child('sim-publisher') });
    this.guildId = null;
    this.ids = {};
    this.brandPosts = [];
  }

  attach() {
    this.engine.setGateway(this.gateway);
    this.engine.setPublisher(this.publisher);
  }

  seed() {
    const gw = this.gateway;
    const g = gw.addGuild({ name: 'Comunidad Demo', icon: AVATAR(5) });
    this.guildId = g.id;
    const general = gw.addChannel(g.id, { name: 'general' });
    const tareas = gw.addChannel(g.id, { name: 'tareas-x' });
    const logs = gw.addChannel(g.id, { name: 'staff-logs' });
    const staff = gw.addRole(g.id, { name: 'Staff', color: '#ED4245', staff: true });
    const raiders = gw.addRole(g.id, { name: 'Raiders', color: '#1D9BF0' });
    const avisos = gw.addRole(g.id, { name: 'Avisos X', color: '#FEE75C' });
    this.ids = { general: general.id, tareas: tareas.id, logs: logs.id, staffRole: staff.id, raidersRole: raiders.id, avisosRole: avisos.id, users: {} };

    this.engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.icon });
    MEMBERS.forEach((m, i) => {
      const roles = m.staff ? [staff.id, raiders.id] : [raiders.id];
      const u = gw.addMember(g.id, { username: m.username, name: m.name, avatar: AVATAR(i), roles });
      this.ids.users[m.username] = u.id;
      this.mock.addProfile({ handle: m.x, name: m.name, description: `Hola, soy ${m.name} 👋`, avatar: AVATAR(i) });
    });

    this.mock.addProfile({ handle: 'marca_demo', name: 'Marca Demo', description: 'Cuenta oficial de la marca de demostración', avatar: AVATAR(5), followers: 48210 });
    this.brandPosts = BRAND_POSTS.map((text, i) =>
      this.mock.addTweet({
        handle: 'marca_demo',
        text,
        createdAt: Date.now() - (i + 1) * 3600_000,
        metrics: { likes: 120 + i * 37, reposts: 30 + i * 9, replies: 14 + i * 4, quotes: 3 + i, views: 5400 + i * 800 },
      }),
    );

    this.engine.updateSettings(g.id, {
      tasksChannelId: tareas.id,
      logChannelId: logs.id,
      participantRoleId: raiders.id,
      staffRoleId: staff.id,
      pingRoleId: null,
      defaultDurationMinutes: 60,
    });
    return this.ids;
  }

  userObject(id) {
    const u = this.gateway.users.get(id);
    if (!u) throw new SimInteractionError('Usuario simulado desconocido');
    return {
      id: u.id,
      username: u.username,
      globalName: u.globalName,
      bot: u.bot,
      avatar: u.avatar,
      displayAvatarURL: () => u.avatar,
    };
  }

  handleOf(userId) {
    const u = this.gateway.users.get(userId);
    return MEMBERS.find((m) => m.username === u?.username)?.x || null;
  }

  async _run(interaction) {
    await this.handler.handle(interaction);
    const errors = interaction.log.filter((l) => l.type === 'error');
    return { ok: errors.length === 0, log: interaction.log, choices: interaction.choices || null, modal: this.pendingModals.get(interaction.user.id)?.modal || null };
  }

  _wrap(fn) {
    return fn().catch((err) => {
      if (err instanceof SimInteractionError || err instanceof PayloadError || err instanceof UserError) {
        return { ok: false, error: err.message };
      }
      throw err;
    });
  }

  command({ userId, channelId, name, subcommand = null, options = {}, attachment = null }) {
    return this._wrap(async () => {
      this.pendingModals.delete(userId);
      const values = { ...options };
      if (attachment) {
        const buffer = attachment.sample ? sampleProofPng() : Buffer.from(String(attachment.dataBase64 || ''), 'base64');
        const contentType = attachment.sample ? 'image/png' : attachment.contentType;
        values[attachment.option || 'image'] = { url: null, contentType, size: buffer.length, name: attachment.name || 'captura.png', buffer };
      }
      const i = new FakeInteraction(this, { kind: 'command', userId, channelId: channelId || this.ids.general, commandName: name, subcommand, values });
      return this._run(i);
    });
  }

  button({ userId, messageId, customId }) {
    return this._wrap(async () => {
      this.pendingModals.delete(userId);
      const msg = this.gateway.findMessage(messageId);
      if (!msg) throw new SimInteractionError('Ese mensaje ya no existe');
      if (msg.ephemeralFor && msg.ephemeralFor !== userId) throw new SimInteractionError('Ese mensaje es privado de otro usuario');
      const exists = (msg.components || []).some((r) => r.components.some((b) => b.custom_id === customId && !b.disabled));
      if (!exists) throw new SimInteractionError('Ese botón no existe en el mensaje (o está desactivado)');
      const i = new FakeInteraction(this, { kind: 'button', userId, channelId: msg.channelId, customId, message: msg });
      return this._run(i);
    });
  }

  modal({ userId, fields = {} }) {
    return this._wrap(async () => {
      const pending = this.pendingModals.get(userId);
      if (!pending) throw new SimInteractionError('No hay ningún formulario abierto');
      this.pendingModals.delete(userId);
      for (const c of pending.modal.components) {
        const v = fields[c.component.custom_id];
        if (c.component.required !== false && (!v || !String(v).trim())) throw new SimInteractionError(`El campo “${c.label}” es obligatorio`);
        if (v && c.component.max_length && String(v).length > c.component.max_length) throw new SimInteractionError(`El campo “${c.label}” es demasiado largo`);
      }
      const message = pending.messageId ? this.gateway.findMessage(pending.messageId) : null;
      const i = new FakeInteraction(this, { kind: 'modal', userId, channelId: pending.channelId, customId: pending.modal.custom_id, fields, message });
      return this._run(i);
    });
  }

  cancelModal(userId) {
    this.pendingModals.delete(userId);
    return { ok: true };
  }

  autocomplete({ userId, name, subcommand = null, focused, options = {} }) {
    return this._wrap(async () => {
      const i = new FakeInteraction(this, { kind: 'autocomplete', userId, channelId: this.ids.general, commandName: name, subcommand, values: options, focused });
      return this._run(i);
    });
  }

  // ─── X simulado ────────────────────────────────────────────────
  xAction({ userId, type, tweetId, text = '' }) {
    const handle = userId ? this.handleOf(userId) : 'marca_demo';
    if (!handle) throw new UserError('Ese usuario no tiene cuenta de X simulada');
    const id = tweetId ? parseTweetUrl(tweetId)?.id || String(tweetId) : null;
    switch (type) {
      case 'bio':
        this.mock.setBio(handle, text);
        return { ok: true, handle, bio: this.mock.getProfileSync(handle).description };
      case 'like':
        return { ok: this.mock.like(handle, id), handle };
      case 'repost':
        this.mock.repost(handle, id);
        return { ok: true, handle };
      case 'reply': {
        if (!text.trim()) throw new UserError('Escribe el texto del comentario');
        const t = this.mock.addTweet({ handle, text: `@${this.mock.tweets.get(id)?.author.handle || 'usuario'} ${text}`, replyTo: id });
        return { ok: true, handle, url: t.url, id: t.id };
      }
      case 'quote': {
        if (!text.trim()) throw new UserError('Escribe el texto de la cita');
        const t = this.mock.addTweet({ handle, text, quoteOf: id });
        return { ok: true, handle, url: t.url, id: t.id };
      }
      case 'post': {
        if (!text.trim()) throw new UserError('Escribe el texto del post');
        const t = this.mock.addTweet({ handle: 'marca_demo', text, metrics: { likes: 10, reposts: 2, replies: 1, quotes: 0, views: 300 } });
        this.brandPosts.unshift(t);
        if (this.brandPosts.length > 10) this.brandPosts.length = 10;
        return { ok: true, handle: 'marca_demo', url: t.url, id: t.id };
      }
      case 'delete':
        return { ok: this.mock.deleteTweet(id) };
      default:
        throw new UserError('Acción desconocida');
    }
  }

  /** Simula que pasa el tiempo en una tarea (para probar recordatorios y cierres automáticos). */
  async advance({ taskId, minutes }) {
    const t = this.engine.store.getTask(Number(taskId));
    if (!t) throw new UserError('No existe esa tarea');
    const ms = Math.max(1, Number(minutes) || 0) * 60_000;
    this.engine.db.run('UPDATE tasks SET created_at = created_at - ?, ends_at = ends_at - ? WHERE id = ?', ms, ms, t.id);
    await this.engine.scheduler.tick();
    await this.engine.scheduler.flush();
    return { ok: true, task: this.engine.store.getTask(t.id) };
  }

  // ─── Estado para la interfaz ───────────────────────────────────
  state(userId, channelId) {
    const gw = this.gateway;
    const g = gw.guilds.get(this.guildId);
    const uid = userId && gw.users.has(userId) ? userId : this.ids.users['lucia'];
    const cid = channelId && gw.channels.has(channelId) ? channelId : this.ids.tareas;
    const users = [...g.members.values()].map((m) => {
      const u = gw.users.get(m.id);
      const link = this.engine.store.getLink(m.id);
      const handle = this.handleOf(m.id);
      const profile = handle ? this.mock.getProfileSync(handle) : null;
      return {
        id: u.id,
        name: u.globalName,
        username: u.username,
        avatar: u.avatar,
        roles: m.roles,
        staff: gw.isStaff(this.guildId, u.id),
        xHandle: handle,
        xBio: profile?.description || '',
        linked: link ? { handle: link.handle, verified: link.verified } : null,
      };
    });
    const visible = (gw.messages.get(cid) || []).filter((m) => !m.ephemeralFor || m.ephemeralFor === uid).slice(-60);
    const tasks = this.engine.store.activeTasks(this.guildId).map((t) => ({ id: t.id, tweetId: t.tweetId, url: t.tweetUrl, text: t.tweet?.text, author: t.tweet?.author?.handle, actions: t.actions }));
    const pending = this.pendingModals.get(uid);
    return {
      guild: { id: g.id, name: g.name, icon: g.icon },
      bot: { ...gw.bot, avatar: gw.bot.avatar },
      channels: this.gateway.listChannels(this.guildId),
      roles: this.gateway.listRoles(this.guildId),
      users,
      userId: uid,
      channelId: cid,
      messages: visible,
      dms: (gw.dms.get(uid) || []).slice(-20),
      modal: pending ? pending.modal : null,
      activeTasks: tasks,
      brandPosts: this.brandPosts.map((t) => ({ id: t.id, url: t.url, text: t.text })),
      commands: commandsJSON(),
    };
  }
}

module.exports = { Simulator, MEMBERS };
