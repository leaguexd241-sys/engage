'use strict';

const MAX_CLIENTS = 60;
const HEARTBEAT_MS = 25_000;

/**
 * Eventos en vivo para el panel (Server-Sent Events).
 * Cada conexión registra sus oyentes y los quita al cerrarse: no quedan referencias colgando.
 */
class LiveEvents {
  constructor({ bus, auth, log }) {
    this.bus = bus;
    this.auth = auth;
    this.log = log;
    this.clients = new Set();
  }

  handler() {
    return (req, res) => {
      if (this.clients.size >= MAX_CLIENTS) return res.status(503).json({ error: 'Demasiadas conexiones en vivo abiertas.' });
      const guildId = String(req.query.guild || '');
      if (guildId && !this.auth.canAccessGuild(req.session, guildId)) return res.status(403).json({ error: 'Sin acceso a ese servidor.' });

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 5000\n\n');

      const allowed = (gid) => (guildId ? gid === guildId : this.auth.canAccessGuild(req.session, gid));
      const send = (event, data) => {
        try {
          if (res.destroyed || res.writableLength > 64 * 1024) {
            cleanup();
            res.destroy();
            return;
          }
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          cleanup();
        }
      };
      const onChange = (ev) => {
        if (ev.guildId && allowed(ev.guildId)) send('change', ev);
      };
      const onAudit = (entry) => {
        if (entry.guildId && allowed(entry.guildId)) send('audit', entry);
      };
      const heartbeat = setInterval(() => {
        try {
          if ((req.session.exp && req.session.exp <= Date.now()) || (req.session.v && req.session.v !== this.auth.version)) {
            cleanup();
            res.end();
            return;
          }
          if (res.writableLength > 64 * 1024) {
            cleanup();
            res.destroy();
            return;
          }
          res.write(': ping\n\n');
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      const client = { res };
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(heartbeat);
        this.bus.off('change', onChange);
        this.bus.off('audit', onAudit);
        this.clients.delete(client);
        req.off('close', cleanup);
        res.off('close', cleanup);
        res.off('error', cleanup);
      };
      client.cleanup = cleanup;
      this.clients.add(client);
      this.bus.on('change', onChange);
      this.bus.on('audit', onAudit);
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      return undefined;
    };
  }

  closeAll() {
    for (const c of [...this.clients]) {
      try {
        c.res.end();
      } catch {
        /* ya cerrada */
      }
      c.cleanup();
    }
  }
}

module.exports = { LiveEvents };
