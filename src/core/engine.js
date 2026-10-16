'use strict';

const path = require('node:path');
const { Store } = require('./store');
const { EventBus } = require('./events');
const { LinkService } = require('./links');
const { TaskService } = require('./tasks');
const { VerificationService } = require('./verification');
const { Scheduler } = require('./scheduler');
const { applySettingsPatch } = require('./settings');
const { UserError } = require('./errors');

/**
 * Punto central: une base de datos, acceso a X, servicios y planificador.
 * No depende de Discord: la conexión con Discord se enchufa con setGateway/setPublisher.
 */
class Engine {
  constructor({ db, x, log, dataDir, config = null }) {
    this.db = db;
    this.x = x;
    this.log = log;
    this.config = config;
    this.startedAt = Date.now();
    this.store = new Store(db);
    this.bus = new EventBus();
    this.links = new LinkService({ store: this.store, x, bus: this.bus, log: log.child('links') });
    this.tasks = new TaskService({ store: this.store, x, bus: this.bus, log: log.child('tasks') });
    this.verification = new VerificationService({
      store: this.store,
      x,
      tasks: this.tasks,
      bus: this.bus,
      log: log.child('verify'),
      proofsDir: dataDir ? path.join(dataDir, 'proofs') : null,
    });
    this.scheduler = new Scheduler(this);
    this.gateway = null;
  }

  setGateway(gateway) {
    this.gateway = gateway;
    this.tasks.setGateway(gateway);
  }

  setPublisher(publisher) {
    this.tasks.setPublisher(publisher);
  }

  updateSettings(guildId, patch, actor = null) {
    const current = this.store.getSettings(guildId);
    const { settings, errors } = applySettingsPatch(current, patch);
    if (errors.length) throw new UserError(`Ajustes no válidos: ${errors.join('; ')}`, 'BAD_SETTINGS', { errors });
    this.store.saveSettings(guildId, settings);
    const entry = this.store.addAudit({ guildId, type: 'settings', actorId: actor?.id || null, actorName: actor?.name || null, message: 'Configuración actualizada', data: patch });
    this.bus.emit('audit', entry);
    this.bus.change(guildId, 'settings', {});
    return settings;
  }

  start() {
    this.scheduler.start();
  }

  stop() {
    this.scheduler.stop();
    this.bus.removeAllListeners();
  }
}

module.exports = { Engine };
