'use strict';

const ui = require('./ui');
const { mapLimit } = require('../util/limiter');

const MAX_DMS_PER_REMINDER = 100;

function isUnknownMessage(err) {
  return err?.code === 10008 || err?.code === 10003 || /Unknown (Message|Channel)/i.test(String(err?.message));
}

/**
 * Traduce los eventos del núcleo (tarea creada, cerrada, recordatorio…) en mensajes de Discord.
 * Funciona con cualquier "gateway" (el real de discord.js o el del simulador).
 */
class DiscordPublisher {
  constructor({ gateway, store, log }) {
    this.gateway = gateway;
    this.store = store;
    this.log = log;
  }

  get online() {
    return this.gateway.isReady();
  }

  async postTask(task, view) {
    const msg = await this.gateway.send(task.channelId, ui.taskMessage(task, view));
    return { channelId: msg.channelId || task.channelId, messageId: msg.id };
  }

  async updateTask(task, view) {
    if (!task.messageId || !task.channelId) return;
    try {
      await this.gateway.edit(task.channelId, task.messageId, ui.taskMessage(task, view));
    } catch (err) {
      if (isUnknownMessage(err)) {
        // Alguien borró el mensaje: dejamos de intentar editarlo.
        this.store.updateTask(task.id, { messageId: null });
        this.log.warn(`El mensaje de la tarea #${task.id} ya no existe en Discord.`);
        return;
      }
      throw err;
    }
  }

  async deleteTaskMessage(task) {
    if (!task.messageId || !task.channelId) return;
    try {
      await this.gateway.delete(task.channelId, task.messageId);
    } catch (err) {
      if (!isUnknownMessage(err)) throw err;
    }
  }

  async sendReminder(task, users, mode, settings) {
    if (!users.length) return { sent: 0, dms: 0 };
    let sent = 0;
    let dms = 0;
    if (mode === 'channel' || mode === 'both') {
      for (const msg of ui.reminderMessages(task, users, { guildId: task.guildId })) {
        await this.gateway.send(task.channelId, msg);
        sent += 1;
      }
    }
    if (mode === 'dm' || mode === 'both') {
      const guild = await this.gateway.getGuild(task.guildId);
      const payload = ui.reminderDM(task, guild?.name);
      const results = await mapLimit(users.slice(0, MAX_DMS_PER_REMINDER), 2, async (u) => {
        try {
          return await this.gateway.dm(u.id, payload);
        } catch {
          return false;
        }
      });
      dms = results.filter(Boolean).length;
    }
    return { sent, dms };
  }

  async sendReport(task, summary, settings) {
    const channelId = settings.report.channelId || task.channelId;
    if (!channelId) return;
    await this.gateway.send(channelId, ui.reportMessage(task, summary, settings, { guildId: task.guildId }));
  }

  async reviewRequest(task, sub, user, imageUrl) {
    const settings = this.store.getSettings(task.guildId);
    if (!settings.logChannelId) return null;
    const msg = await this.gateway.send(settings.logChannelId, ui.reviewMessage(task, sub, user, imageUrl));
    return { channelId: settings.logChannelId, messageId: msg.id };
  }

  async reviewDecided(task, sub, decided) {
    const rm = sub.details?.reviewMessage;
    if (rm?.messageId) {
      const link = this.store.getLink(sub.userId);
      try {
        await this.gateway.edit(rm.channelId, rm.messageId, ui.reviewMessage(task, sub, { xHandle: link?.handle }, rm.imageUrl, { decided }));
      } catch (err) {
        if (!isUnknownMessage(err)) this.log.debug(`No se pudo actualizar el mensaje de revisión: ${err.message}`);
      }
    }
    try {
      await this.gateway.dm(sub.userId, ui.reviewResultDM(task, sub, decided.approve, decided.reason));
    } catch {
      /* MD cerrados */
    }
  }

  async logEvent(guildId, text) {
    const settings = this.store.getSettings(guildId);
    if (!settings.logChannelId) return;
    await this.gateway.send(settings.logChannelId, { content: String(text).slice(0, 1900), allowedMentions: { parse: [] } });
  }
}

module.exports = { DiscordPublisher, isUnknownMessage };
