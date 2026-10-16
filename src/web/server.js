'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Auth } = require('./auth');
const { LiveEvents } = require('./sse');
const { createApi } = require('./api');
const { createSimApi } = require('./sim-api');

const PUBLIC_DIR = path.join(__dirname, 'public');

function securityHeaders(req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob: https://pbs.twimg.com https://abs.twimg.com https://cdn.discordapp.com https://media.discordapp.net",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://discord.com",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

/** Las peticiones que modifican datos deben ser JSON (bloquea CSRF con formularios de otras webs). */
function requireJsonForWrites(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const ct = String(req.headers['content-type'] || '');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (hasBody && !ct.startsWith('application/json')) return res.status(415).json({ error: 'Se esperaba JSON.' });
    if (req.headers['x-requested-with'] !== 'engage-panel') return res.status(403).json({ error: 'Petición no permitida.' });
  }
  return next();
}

/**
 * Arranca el panel web.
 * @returns {Promise<{server: http.Server, auth: Auth, live: LiveEvents, close: () => Promise<void>}>}
 */
async function startWeb({ engine, config, log, sim = null, getBotInfo }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.web.trustProxy) app.set('trust proxy', 1);

  const auth = new Auth({ config, store: engine.store, log: log.child('auth') });
  const live = new LiveEvents({ bus: engine.bus, auth, log });

  app.use(securityHeaders);
  app.use(auth.middleware());

  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));
  app.get('/auth/discord', (req, res) => auth.oauthStart(req, res));
  app.get('/auth/discord/callback', (req, res) => auth.oauthCallback(req, res, { botGuildIds: engine.gateway ? engine.gateway.listGuilds().map((g) => g.id) : [] }));

  app.use('/api', requireJsonForWrites, express.json({ limit: sim ? '12mb' : '200kb' }));
  if (sim) {
    app.use('/api/sim', auth.requireAuth(), createSimApi({ sim, log: log.child('sim') }));
  }
  const api = createApi({ engine, auth, config, log: log.child('api'), live, getBotInfo });
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      etag: true,
      maxAge: 0,
      setHeaders: (res, file) => {
        if (/\.(js|css|svg|png)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('/guia', (req, res) => res.redirect('/docs/guia.html'));
  app.use('/docs', express.static(path.join(config.root, 'docs'), { index: 'guia.html' }));

  // Errores (JSON mal formado, etc.)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON no válido.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'La petición es demasiado grande.' });
    log.error('Error en el servidor web:', err);
    return res.status(500).json({ error: 'Error interno.' });
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.web.port, config.web.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    server,
    auth,
    live,
    port: server.address().port,
    async close() {
      live.closeAll();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await api.idle();
    },
  };
}

module.exports = { startWeb };
