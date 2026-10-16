'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const pkg = require('../package.json');

let envLoaded = false;
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch (err) {
      console.error(`[config] No se pudo leer .env: ${err.message}`);
    }
  }
}

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(String(v).trim().toLowerCase());
}

function int(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function list(v) {
  return String(v || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lee un secreto persistido en disco o lo genera la primera vez. */
function persistedSecret(dataDir, file, generator) {
  const full = path.join(dataDir, file);
  try {
    const existing = fs.readFileSync(full, 'utf8').trim();
    if (existing) return { value: existing, generated: false, file: full };
  } catch {
    /* no existe todavía */
  }
  const value = generator();
  fs.writeFileSync(full, value + '\n', { mode: 0o600 });
  return { value, generated: true, file: full };
}

/**
 * Construye la configuración a partir de variables de entorno.
 * @param {{demo?: boolean, overrides?: object}} [opts]
 */
function buildConfig(opts = {}) {
  loadEnv();
  const env = process.env;
  const demo = Boolean(opts.demo);
  const o = opts.overrides || {};

  // Railway (y otras plataformas similares) se detectan solas: puerto, red, dominio y volumen.
  const railway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID);
  const cloud = railway || Boolean(env.RENDER || env.FLY_APP_NAME || env.KOYEB_APP_NAME);

  const dataDir = path.resolve(ROOT, o.dataDir || env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || (demo ? 'data-demo' : 'data'));
  fs.mkdirSync(dataDir, { recursive: true });

  // PORT es el estándar de las plataformas en la nube y tiene prioridad.
  const port = int(o.port ?? env.PORT ?? env.DASHBOARD_PORT, demo ? 3100 : 3000);
  const host = o.host || env.DASHBOARD_HOST || (cloud ? '0.0.0.0' : '127.0.0.1');
  const platformUrl = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : env.RENDER_EXTERNAL_URL || '';
  const publicUrl = String(o.publicUrl || env.PUBLIC_URL || platformUrl || `http://localhost:${port}`).replace(/\/+$/, '');

  const sessionSecret =
    o.sessionSecret ||
    env.SESSION_SECRET ||
    persistedSecret(dataDir, '.session-secret', () => crypto.randomBytes(48).toString('base64url')).value;

  let password = o.password ?? env.DASHBOARD_PASSWORD ?? '';
  let passwordFile = null;
  let passwordGenerated = false;
  if (!password) {
    if (demo) {
      password = 'demo';
    } else {
      const p = persistedSecret(dataDir, 'admin-password.txt', () => crypto.randomBytes(9).toString('base64url'));
      password = p.value;
      passwordFile = p.file;
      passwordGenerated = p.generated;
    }
  }

  const token = o.token ?? env.DISCORD_TOKEN ?? '';
  const simulator = demo || bool(o.simulator ?? env.SIMULATOR, false);

  return {
    root: ROOT,
    version: pkg.version,
    platform: railway ? 'railway' : cloud ? 'cloud' : 'local',
    demo,
    dataDir,
    dbFile: o.dbFile || path.join(dataDir, 'engage.db'),
    logLevel: o.logLevel || env.LOG_LEVEL || 'info',
    logToFile: o.logToFile ?? bool(env.LOG_TO_FILE, true),
    simulator,
    discord: {
      token: demo && !o.token ? '' : token,
      clientId: o.clientId ?? env.DISCORD_CLIENT_ID ?? '',
      clientSecret: o.clientSecret ?? env.DISCORD_CLIENT_SECRET ?? '',
      devGuildId: o.devGuildId ?? env.DEV_GUILD_ID ?? '',
      ownerIds: list(o.ownerIds ?? env.OWNER_IDS),
      apiBase: o.discordApiBase || env.DISCORD_API_BASE || 'https://discord.com/api/v10',
    },
    web: {
      enabled: o.webEnabled ?? bool(env.DASHBOARD_ENABLED, true),
      port,
      host,
      publicUrl,
      password,
      passwordFile,
      passwordGenerated,
      sessionSecret,
      sessionHours: int(env.SESSION_HOURS, 72),
      trustProxy: bool(o.trustProxy ?? env.TRUST_PROXY, cloud),
      secureCookies: publicUrl.startsWith('https://'),
    },
    twitter: {
      timeoutMs: int(env.X_TIMEOUT_MS, 9000),
      concurrency: int(env.X_CONCURRENCY, 4),
      providers: list(env.X_PROVIDERS || 'fxtwitter,syndication'),
      userAgent:
        env.X_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    },
  };
}

module.exports = { buildConfig, ROOT, bool, int, list };
