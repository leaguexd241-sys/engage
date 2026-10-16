'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const NEEDED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
const PERM_NAMES = {
  ViewChannel: 'Ver canal',
  SendMessages: 'Enviar mensajes',
  EmbedLinks: 'Insertar enlaces',
};

/** Operaciones de Discord que necesita el bot, implementadas con discord.js. */
class DiscordGateway {
  constructor(client, { membersIntent = true, log } = {}) {
    this.client = client;
    this.membersIntent = membersIntent;
    this.log = log;
    this.kind = 'discord';
  }

  isReady() {
    return this.client.isReady();
  }

  botUser() {
    const u = this.client.user;
    if (!u) return null;
    return { id: u.id, tag: u.tag, username: u.username, avatar: u.displayAvatarURL({ size: 128 }) };
  }

  _guildInfo(g) {
    return { id: g.id, name: g.name, icon: g.iconURL({ size: 128 }), memberCount: g.memberCount };
  }

  listGuilds() {
    return [...this.client.guilds.cache.values()].map((g) => this._guildInfo(g));
  }

  async getGuild(id) {
    const g = this.client.guilds.cache.get(id);
    return g ? this._guildInfo(g) : null;
  }

  listChannels(guildId) {
    const g = this.client.guilds.cache.get(guildId);
    if (!g) return [];
    const me = g.members.me;
    return [...g.channels.cache.values()]
      .filter((c) => TEXT_TYPES.has(c.type))
      .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type === ChannelType.GuildAnnouncement ? 'announcement' : 'text',
        parentName: c.parent?.name || null,
        canPost: me ? c.permissionsFor(me)?.has(NEEDED) ?? false : false,
      }));
  }

  listRoles(guildId) {
    const g = this.client.guilds.cache.get(guildId);
    if (!g) return [];
    return [...g.roles.cache.values()]
      .filter((r) => r.id !== g.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, managed: r.managed, position: r.position }));
  }

  async getRoleMembers(guildId, roleId) {
    if (!this.membersIntent) return null;
    const g = this.client.guilds.cache.get(guildId);
    if (!g) return null;
    if (!g.roles.cache.has(roleId)) return [];
    const all = await g.members.fetch({ time: 60_000 });
    return [...all.values()]
      .filter((m) => m.roles.cache.has(roleId))
      .map((m) => ({ id: m.id, name: m.displayName, username: m.user.username, avatar: m.displayAvatarURL({ size: 64 }), bot: m.user.bot }));
  }

  async getMemberInfo(guildId, userId) {
    const g = this.client.guilds.cache.get(guildId);
    if (!g) return null;
    try {
      const m = await g.members.fetch(userId);
      return { id: m.id, name: m.displayName, username: m.user.username, avatar: m.displayAvatarURL({ size: 64 }), bot: m.user.bot };
    } catch {
      return null;
    }
  }

  async _textChannel(channelId) {
    const c = await this.client.channels.fetch(channelId).catch(() => null);
    if (!c || !c.isTextBased?.() || !c.guild) throw new Error('El canal no existe o no es un canal de texto del servidor');
    const me = c.guild.members.me;
    const perms = me ? c.permissionsFor(me) : null;
    const missing = perms ? perms.missing(NEEDED) : [];
    if (missing.length) {
      throw new Error(`faltan permisos en #${c.name}: ${missing.map((p) => PERM_NAMES[p] || p).join(', ')}`);
    }
    return c;
  }

  async send(channelId, payload) {
    const c = await this._textChannel(channelId);
    const m = await c.send(payload);
    return { id: m.id, channelId: c.id };
  }

  async edit(channelId, messageId, payload) {
    const c = await this.client.channels.fetch(channelId);
    if (!c?.messages) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
    await c.messages.edit(messageId, payload);
  }

  async delete(channelId, messageId) {
    const c = await this.client.channels.fetch(channelId);
    if (!c?.messages) return;
    await c.messages.delete(messageId);
  }

  async dm(userId, payload) {
    const u = await this.client.users.fetch(userId);
    await u.send(payload);
    return true;
  }
}

module.exports = { DiscordGateway };
