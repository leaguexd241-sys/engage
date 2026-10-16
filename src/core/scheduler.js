'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TICK_MS = 15_000;
const FLUSH_MS = 4_000;
const METRICS_EVERY_MS = 10 * 60_000;
const MAINTENANCE_EVERY_MS = 6 * 3600_000;
const AUDIT_RETENTION_MS = 90 * 86400_000;
const PROOF_RETENTION_MS = 45 * 86400_000;

/**
 * Tareas periódicas del bot. Usa sólo dos temporizadores (con unref) y
 * nunca solapa ejecuciones, así que no acumula trabajo ni memoria.
 */
class Scheduler {
  constructor(engine) {
    this.engine = engine;
    this.log = engine.log.child('scheduler');
    this.timers = [];
    this.running = false;
    this.flushing = false;
    this.lastMaintenance = 0;
    this.stopped = true;
    this.activeJobs = new Set();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timers.push(setInterval(() => this.track(this.tick()), TICK_MS));
    this.timers.push(setInterval(() => this.track(this.flush()), FLUSH_MS));
    for (const t of this.timers) t.unref?.();
    setImmediate(() => this.track(this.tick()));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    return Promise.allSettled([...this.activeJobs]);
  }

  track(job) {
    this.activeJobs.add(job);
    job.then(() => this.activeJobs.delete(job), () => this.activeJobs.delete(job));
    return job;
  }

  async flush() {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      await this.engine.tasks.flushDirty();
    } catch (err) {
      this.log.warn(`Error actualizando mensajes: ${err.message}`);
    } finally {
      this.flushing = false;
    }
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.closeDue();
      await this.sendReminders();
      await this.refreshMetrics();
      this.maintenance();
    } catch (err) {
      this.log.error('Error en el ciclo del planificador:', err);
    } finally {
      this.running = false;
    }
  }

  async closeDue() {
    const { store, tasks } = this.engine;
    for (const task of store.dueTasks(Date.now())) {
      if (this.stopped) return;
      try {
        await tasks._close(task, { id: null, name: 'Automático' });
        this.log.info(`Tarea #${task.id} cerrada automáticamente`);
      } catch (err) {
        this.log.error(`No se pudo cerrar la tarea #${task.id}:`, err);
      }
    }
  }

  async sendReminders() {
    const { store, tasks } = this.engine;
    const now = Date.now();
    for (const task of store.activeTasks()) {
      if (this.stopped) return;
      if (task.remindedAt) continue;
      const settings = store.getSettings(task.guildId);
      if (!settings.reminders.enabled) continue;
      const duration = task.endsAt - task.createdAt;
      const before = Math.min(settings.reminders.minutesBefore * 60_000, duration / 2);
      if (now < task.endsAt - before || now >= task.endsAt) continue;
      try {
        const r = await tasks.remind(task.guildId, task.id, { manual: false, actor: { id: null, name: 'Automático' } });
        this.log.info(`Recordatorio de la tarea #${task.id} enviado a ${r.targets} miembros`);
      } catch (err) {
        store.updateTask(task.id, { remindedAt: now });
        this.log.warn(`Recordatorio de la tarea #${task.id} falló: ${err.message}`);
      }
    }
  }

  async refreshMetrics() {
    const { store, tasks } = this.engine;
    const now = Date.now();
    for (const task of store.activeTasks()) {
      if (this.stopped) return;
      if (task.metricsCheckedAt && now - task.metricsCheckedAt < METRICS_EVERY_MS) continue;
      try {
        await tasks.refreshMetrics(task);
      } catch (err) {
        store.updateTask(task.id, { metricsCheckedAt: now });
        this.log.debug(`Métricas de #${task.id} no disponibles: ${err.message}`);
      }
    }
  }

  maintenance(force = false) {
    const now = Date.now();
    if (!force && now - this.lastMaintenance < MAINTENANCE_EVERY_MS) return;
    this.lastMaintenance = now;
    const { store, x, verification } = this.engine;
    try {
      const a = store.pruneAudit(AUDIT_RETENTION_MS);
      const l = store.pruneLinkRequests();
      x.prune();
      let p = 0;
      if (verification.proofsDir) {
        for (const f of fs.readdirSync(verification.proofsDir)) {
          const full = path.join(verification.proofsDir, f);
          try {
            if (now - fs.statSync(full).mtimeMs > PROOF_RETENTION_MS) {
              fs.rmSync(full, { force: true });
              p += 1;
            }
          } catch {
            /* ignorar */
          }
        }
      }
      if (a || l || p) this.log.info(`Mantenimiento: ${a} registros antiguos, ${l} códigos caducados y ${p} capturas antiguas eliminados`);
    } catch (err) {
      this.log.warn(`Mantenimiento falló: ${err.message}`);
    }
  }
}

module.exports = { Scheduler, TICK_MS };
