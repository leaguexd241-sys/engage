'use strict';

const { EventEmitter } = require('node:events');
const { validateMessage } = require('./validate');

const MAX_MESSAGES_PER_CHANNEL = 150;
const MAX_DMS_PER_USER = 50;
const DISCORD_EPOCH = 1420070400000n;

/**
 * "Discord" en memoria para el simulador y las pruebas.
 * Implementa la misma interfaz que DiscordGateway (discord.js).
 */
class SimGateway extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.kind = 'simulator';
    this.seq = 0n;
    this.guilds = new Map();
    this.channels = new Map();
    this.messages = new Map(); // channelId -> [msg]
    this.dms = new Map(); // userId -> [msg]
    this.users = new Map();
    this.bot = { id: this.snowflake(), username: 'Engage Bot', tag: 'Engage Bot#0001', avatar: null, bot: true };
    this.failSends = false;
  }

  snowflake() {
    this.seq = (this.seq + 1n) % 4096n;
    return String(((BigInt(Date.now()) - DISCORD_EPOCH) << 22n) | this.seq);
  }

  isReady() {
    return true;
  }

  botUser() {
    return { ...this.bot };
  }

  addGuild({ id = this.snowflake(), name, icon = null }) {
    const g = { id, name, icon, roles: new Map(), members: new Map(), channelIds: [] };
    this.guilds.set(id, g);
    return g;
  }

  addChannel(guildId, { id = this.snowflake(), name, type = 'text', canPost = true }) {
    const c = { id, guildId, name, type, canPost };
    this.channels.set(id, c);
    this.guilds.get(guildId).channelIds.push(id);
    this.messages.set(id, []);
    return c;
  }

  addRole(guildId, { id = this.snowflake(), name, color = '#99AAB5', staff = false }) {
    const r = { id, name, color, staff, managed: false };
    this.guilds.get(guildId).roles.set(id, r);
    return r;
  }

  addMember(guildId, { id = this.snowflake(), username, name, avatar = null, roles = [], bot = false }) {
    const user = { id, username, globalName: name || username, avatar, bot };
    this.users.set(id, user);
    this.guilds.get(guildId).members.set(id, { id, roles: [...roles] });
    return user;
  }

  memberRoles(guildId, userId) {
    return this.guilds.get(guildId)?.members.get(userId)?.roles || [];
  }

  isStaff(guildId, userId) {
    const g = this.guilds.get(guildId);
    return this.memberRoles(guildId, userId).some((r) => g?.roles.get(r)?.staff);
  }

  listGuilds() {
    return [...this.guilds.values()].map((g) => ({ id: g.id, name: g.name, icon: g.icon, memberCount: g.members.size }));
  }

  async getGuild(id) {
    const g = this.guilds.get(id);
    return g ? { id: g.id, name: g.name, icon: g.icon, memberCount: g.members.size } : null;
  }

  listChannels(guildId) {
    const g = this.guilds.get(guildId);
    if (!g) return [];
    return g.channelIds.map((id) => {
      const c = this.channels.get(id);
      return { id: c.id, name: c.name, type: c.type, parentName: 'Simulador', canPost: c.canPost };
    });
  }

  listRoles(guildId) {
    const g = this.guilds.get(guildId);
    if (!g) return [];
    return [...g.roles.values()].map((r, i) => ({ id: r.id, name: r.name, color: r.color, managed: false, position: 100 - i }));
  }

  async getRoleMembers(guildId, roleId) {
    const g = this.guilds.get(guildId);
    if (!g) return null;
    const out = [];
    for (const m of g.members.values()) {
      if (m.roles.includes(roleId)) {
        const u = this.users.get(m.id);
        out.push({ id: u.id, name: u.globalName, username: u.username, avatar: u.avatar, bot: u.bot });
      }
    }
    return out;
  }

  async getMemberInfo(guildId, userId) {
    const u = this.users.get(userId);
    if (!u || !this.guilds.get(guildId)?.members.has(userId)) return null;
    return { id: u.id, name: u.globalName, username: u.username, avatar: u.avatar, bot: u.bot };
  }

  _push(list, msg, max) {
    list.push(msg);
    if (list.length > max) list.splice(0, list.length - max);
  }

  /** Publica un mensaje (del bot, salvo que se indique otro autor). */
  post(channelId, payload, { author = null, ephemeralFor = null, interaction = null, skipValidation = false } = {}) {
    if (!skipValidation) validateMessage(payload);
    const c = this.channels.get(channelId);
    if (!c) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
    const msg = {
      id: this.snowflake(),
      channelId,
      guildId: c.guildId,
      author: author || { id: this.bot.id, name: this.bot.username, avatar: this.bot.avatar, bot: true },
      content: payload.content || '',
      embeds: structuredClone(payload.embeds || []),
      components: structuredClone(payload.components || []),
      ephemeralFor,
      interaction,
      createdAt: Date.now(),
      editedAt: null,
    };
    this._push(this.messages.get(channelId), msg, MAX_MESSAGES_PER_CHANNEL);
    this.emit('update', { channelId });
    return msg;
  }

  findMessage(messageId) {
    for (const list of this.messages.values()) {
      const m = list.find((x) => x.id === messageId);
      if (m) return m;
    }
    for (const list of this.dms.values()) {
      const m = list.find((x) => x.id === messageId);
      if (m) return m;
    }
    return null;
  }

  applyEdit(msg, payload) {
    validateMessage(payload, { edit: true });
    if (payload.content !== undefined) msg.content = payload.content || '';
    if (payload.embeds !== undefined) msg.embeds = structuredClone(payload.embeds);
    if (payload.components !== undefined) msg.components = structuredClone(payload.components);
    msg.editedAt = Date.now();
    this.emit('update', { channelId: msg.channelId });
    return msg;
  }

  async send(channelId, payload) {
    if (this.failSends) throw new Error('faltan permisos en el canal (fallo simulado)');
    const c = this.channels.get(channelId);
    if (!c) throw new Error('El canal no existe o no es un canal de texto del servidor');
    if (!c.canPost) throw new Error(`faltan permisos en #${c.name}: Enviar mensajes`);
    const m = this.post(channelId, payload);
    return { id: m.id, channelId };
  }

  async edit(channelId, messageId, payload) {
    const m = (this.messages.get(channelId) || []).find((x) => x.id === messageId);
    if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    this.applyEdit(m, payload);
  }

  async delete(channelId, messageId) {
    const list = this.messages.get(channelId) || [];
    const idx = list.findIndex((x) => x.id === messageId);
    if (idx === -1) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
    list.splice(idx, 1);
    this.emit('update', { channelId });
  }

  async dm(userId, payload) {
    validateMessage(payload);
    if (!this.users.has(userId)) throw new Error('Unknown User');
    if (!this.dms.has(userId)) this.dms.set(userId, []);
    const msg = {
      id: this.snowflake(),
      channelId: `dm-${userId}`,
      author: { id: this.bot.id, name: this.bot.username, avatar: this.bot.avatar, bot: true },
      content: payload.content || '',
      embeds: structuredClone(payload.embeds || []),
      components: structuredClone(payload.components || []),
      createdAt: Date.now(),
    };
    this._push(this.dms.get(userId), msg, MAX_DMS_PER_USER);
    this.emit('update', { dm: userId });
    return true;
  }

  clearEphemerals(userId) {
    for (const [channelId, list] of this.messages) {
      const before = list.length;
      const kept = list.filter((m) => m.ephemeralFor !== userId);
      if (kept.length !== before) {
        this.messages.set(channelId, kept);
      }
    }
  }
}

module.exports = { SimGateway };
