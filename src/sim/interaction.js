'use strict';

const { PermissionFlagsBits } = require('discord.js');

const EPHEMERAL = 64;
const RESPONSE_DEADLINE_MS = 3000;

class SimInteractionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimInteractionError';
  }
}

class FakeOptions {
  constructor(sim, { subcommand = null, values = {}, focused = null }) {
    this.sim = sim;
    this.sub = subcommand;
    this.values = values || {};
    this.focused = focused;
  }

  _get(name, required) {
    const v = this.values[name];
    if (v === undefined || v === null || v === '') {
      if (required) throw new SimInteractionError(`Falta la opción obligatoria "${name}"`);
      return null;
    }
    return v;
  }

  getSubcommand(required = true) {
    if (!this.sub && required) throw new SimInteractionError('Falta el subcomando');
    return this.sub;
  }

  getString(name, required = false) {
    const v = this._get(name, required);
    return v === null ? null : String(v);
  }

  getInteger(name, required = false) {
    const v = this._get(name, required);
    if (v === null) return null;
    const n = Number.parseInt(String(v).replace('#', ''), 10);
    if (!Number.isFinite(n)) throw new SimInteractionError(`La opción "${name}" debe ser un número entero`);
    return n;
  }

  getNumber(name, required = false) {
    const v = this._get(name, required);
    if (v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new SimInteractionError(`La opción "${name}" debe ser un número`);
    return n;
  }

  getBoolean(name, required = false) {
    const v = this._get(name, required);
    if (v === null) return null;
    return v === true || v === 'true';
  }

  getUser(name, required = false) {
    const id = this._get(name, required);
    return id === null ? null : this.sim.userObject(String(id));
  }

  getRole(name, required = false) {
    const id = this._get(name, required);
    if (id === null) return null;
    const role = this.sim.gateway.guilds.get(this.sim.guildId)?.roles.get(String(id));
    if (!role) throw new SimInteractionError('Rol no encontrado');
    return { id: role.id, name: role.name };
  }

  getChannel(name, required = false) {
    const id = this._get(name, required);
    if (id === null) return null;
    const c = this.sim.gateway.channels.get(String(id));
    if (!c) throw new SimInteractionError('Canal no encontrado');
    return { id: c.id, name: c.name };
  }

  getAttachment(name, required = false) {
    return this._get(name, required);
  }

  getFocused(full = false) {
    if (!this.focused) return full ? { name: '', value: '' } : '';
    return full ? this.focused : this.focused.value;
  }
}

/**
 * Interacción de Discord simulada. Aplica las mismas reglas que Discord
 * (una sola respuesta inicial, 3 segundos para responder, modales sólo como primera respuesta…)
 * para que los errores de lógica salgan en el simulador y no en producción.
 */
class FakeInteraction {
  constructor(sim, { kind, userId, channelId, commandName = null, subcommand = null, values = {}, focused = null, customId = null, fields = {}, message = null }) {
    this.sim = sim;
    this.kind = kind;
    this.createdAt = Date.now();
    this.id = sim.gateway.snowflake();
    this.guildId = sim.guildId;
    this.channelId = channelId;
    const g = sim.gateway.guilds.get(sim.guildId);
    this.guild = { id: g.id, name: g.name };
    this.user = sim.userObject(userId);
    const roles = sim.gateway.memberRoles(sim.guildId, userId);
    const staff = sim.gateway.isStaff(sim.guildId, userId);
    this.member = { displayName: this.user.globalName, nick: null, roles };
    this.memberPermissions = {
      has: (flag) => staff && (flag === PermissionFlagsBits.ManageGuild || flag === PermissionFlagsBits.Administrator),
    };
    this.commandName = commandName;
    this.customId = customId;
    this.options = new FakeOptions(sim, { subcommand, values, focused });
    this.fields = {
      getTextInputValue: (id) => {
        if (!(id in fields)) throw new SimInteractionError(`El formulario no tiene el campo "${id}"`); // igual que discord.js (no es un fallo de protocolo)
        return String(fields[id] ?? '');
      },
    };
    this.message = message;
    this.deferred = false;
    this.replied = false;
    this.ephemeral = false;
    this.replyMessage = null;
    this.log = [];
  }

  isAutocomplete() {
    return this.kind === 'autocomplete';
  }
  isChatInputCommand() {
    return this.kind === 'command';
  }
  isButton() {
    return this.kind === 'button';
  }
  isModalSubmit() {
    return this.kind === 'modal';
  }
  isFromMessage() {
    return this.kind === 'modal' && Boolean(this.message);
  }
  inGuild() {
    return true;
  }

  _err(message) {
    const err = new SimInteractionError(message);
    this.log.push({ type: 'error', message });
    return err;
  }

  _checkDeadline(what) {
    const ms = Date.now() - this.createdAt;
    if (ms > RESPONSE_DEADLINE_MS) {
      const err = new SimInteractionError(`La primera respuesta (${what}) tardó ${ms} ms. Discord exige responder en menos de 3 s: la interacción habría fallado.`);
      this.log.push({ type: 'error', message: err.message });
      throw err;
    }
  }

  _assertFresh(what) {
    if (this.replied || this.deferred) throw this._err(`No se puede usar ${what}: la interacción ya fue respondida`);
    this._checkDeadline(what);
  }

  _interactionRef() {
    return this.kind === 'command'
      ? { user: { id: this.user.id, name: this.user.globalName }, command: `/${this.commandName}${this.options.sub ? ` ${this.options.sub}` : ''}` }
      : null;
  }

  async reply(payload) {
    this._assertFresh('reply()');
    this.replied = true;
    this.ephemeral = Boolean((payload.flags || 0) & EPHEMERAL);
    this.replyMessage = this.sim.gateway.post(this.channelId, payload, {
      ephemeralFor: this.ephemeral ? this.user.id : null,
      interaction: this._interactionRef(),
    });
    this.log.push({ type: 'reply', ephemeral: this.ephemeral, messageId: this.replyMessage.id });
    return this.replyMessage;
  }

  async deferReply(opts = {}) {
    this._assertFresh('deferReply()');
    this.deferred = true;
    this.ephemeral = Boolean((opts.flags || 0) & EPHEMERAL);
    this.replyMessage = this.sim.gateway.post(
      this.channelId,
      { content: '⏳ *Engage Bot está pensando…*' },
      { ephemeralFor: this.ephemeral ? this.user.id : null, interaction: this._interactionRef() },
    );
    this.log.push({ type: 'defer', ephemeral: this.ephemeral });
  }

  async editReply(payload) {
    if (!this.deferred && !this.replied) throw this._err('editReply() antes de responder');
    if (payload.flags) throw this._err('editReply() no puede cambiar los flags del mensaje');
    if (!this.replyMessage) throw this._err('No hay respuesta que editar');
    this.sim.gateway.applyEdit(this.replyMessage, { content: payload.content ?? '', embeds: payload.embeds || [], components: payload.components || [] });
    this.log.push({ type: 'editReply' });
    return this.replyMessage;
  }

  async followUp(payload) {
    if (!this.deferred && !this.replied) throw this._err('followUp() antes de responder');
    const eph = Boolean((payload.flags || 0) & EPHEMERAL);
    const m = this.sim.gateway.post(this.channelId, payload, { ephemeralFor: eph ? this.user.id : null });
    this.log.push({ type: 'followUp', ephemeral: eph });
    return m;
  }

  async showModal(modal) {
    if (this.kind === 'modal') throw this._err('Un formulario no puede abrir otro formulario');
    this._assertFresh('showModal()');
    try {
      validateModal(modal);
    } catch (e) {
      throw this._err(e.message);
    }
    this.replied = true;
    this.sim.pendingModals.set(this.user.id, { modal, messageId: this.message?.id || null, channelId: this.channelId });
    this.log.push({ type: 'modal', customId: modal.custom_id });
  }

  async update(payload) {
    if (!this.message) throw this._err('update() sólo funciona en interacciones de un mensaje');
    this._assertFresh('update()');
    if (payload.flags) throw this._err('update() no puede cambiar los flags');
    this.replied = true;
    const msg = this.sim.gateway.findMessage(this.message.id);
    if (msg) this.sim.gateway.applyEdit(msg, payload);
    this.log.push({ type: 'update' });
  }

  async deferUpdate() {
    if (!this.message) throw this._err('deferUpdate() sólo funciona en interacciones de un mensaje');
    this._assertFresh('deferUpdate()');
    this.deferred = true;
    this.log.push({ type: 'deferUpdate' });
  }

  async respond(choices) {
    if (this.kind !== 'autocomplete') throw this._err('respond() sólo para autocompletado');
    if (!Array.isArray(choices) || choices.length > 25) throw this._err('Autocompletado: máximo 25 opciones');
    for (const c of choices) {
      if (!c.name || String(c.name).length > 100) throw this._err('Autocompletado: nombre vacío o de más de 100 caracteres');
    }
    this.log.push({ type: 'autocomplete', choices });
    this.choices = choices;
  }
}

/** Valida un modal como lo haría la API de Discord. */
function validateModal(modal) {
  if (!modal?.custom_id || modal.custom_id.length > 100) throw new SimInteractionError('Modal sin custom_id válido');
  if (!modal.title || modal.title.length > 45) throw new SimInteractionError('El título del modal debe tener 1-45 caracteres');
  if (!Array.isArray(modal.components) || modal.components.length < 1 || modal.components.length > 5) {
    throw new SimInteractionError('El modal debe tener entre 1 y 5 componentes');
  }
  for (const c of modal.components) {
    if (c.type !== 18 || !c.component) throw new SimInteractionError('Cada campo del modal debe ser una etiqueta (tipo 18) con un componente');
    if (!c.label || c.label.length > 45) throw new SimInteractionError('La etiqueta de un campo debe tener 1-45 caracteres');
  }
}

module.exports = { FakeInteraction, FakeOptions, SimInteractionError, validateModal };
