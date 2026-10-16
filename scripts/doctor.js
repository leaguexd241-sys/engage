'use strict';

/**
 * Diagnóstico: comprueba que todo está listo para funcionar.
 *   npm run doctor
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { buildConfig } = require('../src/config');
const { XService } = require('../src/twitter/service');
const { Logger } = require('../src/logger');

const OK = '\x1b[32m✔\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';
const BAD = '\x1b[31m✖\x1b[0m';
let problems = 0;
let warnings = 0;

function line(icon, title, detail = '') {
  console.log(`${icon} ${title}${detail ? `\n    ${detail.split('\n').join('\n    ')}` : ''}`);
  if (icon === BAD) problems += 1;
  if (icon === WARN) warnings += 1;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function discordGet(apiBase, route, token) {
  const res = await fetch(`${apiBase}${route}`, { headers: { authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  console.log('\n🔎 Diagnóstico del bot de engage\n');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) line(OK, `Node.js ${process.version}`);
  else line(BAD, `Node.js ${process.version} es demasiado antiguo`, 'Instala Node.js 22.13 o superior (recomendado 24 LTS) desde https://nodejs.org');

  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) line(OK, 'Archivo .env encontrado');
  else line(WARN, 'No hay archivo .env', 'Copia .env.example como .env y rellena DISCORD_TOKEN (ver la guía).');

  let config;
  try {
    config = buildConfig();
    line(OK, `Carpeta de datos: ${config.dataDir}`);
  } catch (err) {
    line(BAD, 'No se pudo leer la configuración', err.message);
    return finish();
  }
  try {
    fs.accessSync(config.dataDir, fs.constants.W_OK);
    line(OK, 'Se puede escribir en la carpeta de datos');
  } catch {
    line(BAD, 'No se puede escribir en la carpeta de datos', 'Revisa los permisos de la carpeta o cambia DATA_DIR.');
  }

  // ── Discord ─────────────────────────────────────────
  const { token, apiBase } = config.discord;
  if (!token) {
    line(BAD, 'Falta DISCORD_TOKEN en .env', 'Sin token el bot no puede conectarse a Discord. Puedes probarlo todo sin Discord con: npm run demo');
  } else {
    try {
      const me = await discordGet(apiBase, '/users/@me', token);
      if (me.status === 401) {
        line(BAD, 'El token de Discord no es válido', 'Genera uno nuevo en https://discord.com/developers/applications › tu app › Bot › Reset Token.');
      } else if (me.status !== 200) {
        line(WARN, `Discord respondió ${me.status} al comprobar el token`);
      } else {
        line(OK, `Token válido: ${me.body.username}#${me.body.discriminator || '0'} (ID ${me.body.id})`);
        if (config.discord.clientId && config.discord.clientId !== me.body.id) {
          line(WARN, 'DISCORD_CLIENT_ID no coincide con el ID del bot', `El bot es ${me.body.id}. Normalmente son el mismo número.`);
        }
        const app = await discordGet(apiBase, '/applications/@me', token);
        if (app.status === 200) {
          const flags = Number(app.body.flags || 0);
          const members = (flags & (1 << 14)) !== 0 || (flags & (1 << 15)) !== 0;
          if (members) line(OK, 'Intent "Server Members" activado (el bot sabrá exactamente quién falta)');
          else line(WARN, 'Intent "Server Members" desactivado', 'Actívalo en el portal › Bot › Privileged Gateway Intents › SERVER MEMBERS INTENT.\nSin él, "quién falta" se calcula con los miembros que vincularon su X.');
        }
        const guilds = await discordGet(apiBase, '/users/@me/guilds', token);
        if (guilds.status === 200) {
          if (guilds.body.length) line(OK, `El bot está en ${guilds.body.length} servidor(es): ${guilds.body.map((g) => g.name).join(', ')}`);
          else line(WARN, 'El bot todavía no está en ningún servidor', 'Invítalo con el enlace del panel (Estado del bot › Invitar) o el de la guía.');
        }
      }
    } catch (err) {
      line(WARN, 'No se pudo contactar con Discord', err.message);
    }
  }

  // ── X (sin API) ─────────────────────────────────────
  const x = XService.fromConfig(config, new Logger({ level: 'silent' }));
  try {
    const t = await x.getTweet('20');
    line(OK, `Lectura de X funcionando (fuente: ${t.source}) · "${t.text}"`);
  } catch (err) {
    line(BAD, 'No se pudo leer X', `${err.message}\nComprueba tu conexión a Internet o el cortafuegos (api.fxtwitter.com y cdn.syndication.twimg.com).`);
  }
  for (const p of x.status().providers) {
    if (p.fail && !p.ok) line(WARN, `La fuente "${p.name}" no respondió`, p.lastError || '');
  }

  // ── Panel web ───────────────────────────────────────
  if (config.web.enabled) {
    const free = await portFree(config.web.port, config.web.host);
    if (free) line(OK, `Puerto ${config.web.port} libre para el panel (${config.web.publicUrl})`);
    else line(WARN, `El puerto ${config.web.port} está ocupado`, '¿Ya hay un bot en marcha? Si no, cambia DASHBOARD_PORT en .env.');
    if (config.web.passwordFile) line(OK, `Contraseña del panel en ${config.web.passwordFile}`);
    else line(OK, 'Contraseña del panel definida en DASHBOARD_PASSWORD');
    if (config.discord.clientSecret) line(OK, 'Inicio de sesión con Discord activado', `Añade esta URL de redirección en el portal › OAuth2: ${config.web.publicUrl}/auth/discord/callback`);
    if (config.web.host === '0.0.0.0' && !config.web.publicUrl.startsWith('https://')) {
      line(WARN, 'El panel está abierto a la red sin HTTPS', 'Si lo expones a Internet, ponlo detrás de un proxy con HTTPS (ver la guía).');
    }
  }
  return finish();
}

function finish() {
  console.log('');
  if (problems) console.log(`${BAD} ${problems} problema(s) que impiden funcionar${warnings ? ` y ${warnings} aviso(s)` : ''}.`);
  else if (warnings) console.log(`${WARN} Todo listo, con ${warnings} aviso(s) a revisar.`);
  else console.log(`${OK} ¡Todo listo! Arranca el bot con: npm start`);
  console.log('');
  // Sin process.exit(): dejamos que Node cierre las conexiones con calma (evita un fallo de libuv en Windows).
  process.exitCode = problems ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
