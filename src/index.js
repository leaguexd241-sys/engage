'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildConfig } = require('./config');
const { Logger } = require('./logger');
const { openDatabase } = require('./db/database');
const { XService } = require('./twitter/service');
const { MockX } = require('./twitter/providers/mock');
const { Engine } = require('./core/engine');
const { startWeb } = require('./web/server');

const RETRY_MS = 60_000;

/**
 * Arranca todo: base de datos, motor, bot de Discord (o simulador) y panel web.
 * Devuelve un objeto con stop() para apagarlo limpiamente (lo usan también las pruebas).
 */
async function main({ demo = false, overrides = {}, handleSignals = true } = {}) {
  const config = buildConfig({ demo, overrides });
  const log = new Logger({ level: config.logLevel, dir: config.logToFile ? config.dataDir : null, scope: 'bot' });
  log.info(`Bot de engage v${config.version} · Node ${process.version}${demo ? ' · MODO DEMO' : ''}`);

  if (demo) {
    // La demo empieza siempre desde cero para que los datos de ejemplo sean coherentes.
    for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(config.dataDir, 'proofs'), { recursive: true, force: true });
  }
  const db = openDatabase(config.dbFile);
  const mock = config.simulator ? new MockX() : null;
  const x = XService.fromConfig(config, log.child('x'), { mock });
  const engine = new Engine({ db, x, log, dataDir: config.dataDir, config });

  let discord = null;
  let sim = null;
  let discordError = null;
  let retryTimer = null;
  let stopping = false;

  const connectDiscord = async () => {
    const { startDiscord } = require('./discord/client');
    try {
      discord = await startDiscord({ engine, config, log: log.child('discord') });
      discordError = null;
    } catch (err) {
      discordError = err.code === 'TokenInvalid' ? 'El token de Discord no es válido (revisa DISCORD_TOKEN en .env).' : err.message;
      log.error(`No se pudo conectar a Discord: ${discordError}`);
      if (err.code !== 'TokenInvalid' && !stopping) {
        log.info(`Reintentando en ${RETRY_MS / 1000} s…`);
        retryTimer = setTimeout(connectDiscord, RETRY_MS);
      }
    }
  };

  if (config.discord.token) {
    await connectDiscord();
  } else if (config.simulator) {
    const { Simulator } = require('./sim/simulator');
    sim = new Simulator({ engine, mock, config, log: log.child('sim') });
    sim.attach();
    sim.seed();
    if (demo) {
      const { seedDemoData } = require('./sim/demo-data');
      await seedDemoData({ engine, sim, log: log.child('demo') });
    }
    log.info('Simulador de Discord activo (servidor "Comunidad Demo").');
  } else {
    discordError = 'Falta DISCORD_TOKEN en el archivo .env';
    log.warn('No hay DISCORD_TOKEN: el panel web funciona, pero el bot está desconectado. Para probar sin Discord usa: npm run demo');
  }

  engine.start();

  const getBotInfo = () => {
    if (discord) {
      return {
        kind: 'discord',
        online: discord.gateway.isReady(),
        user: discord.gateway.botUser(),
        guilds: discord.gateway.listGuilds().length,
        membersIntent: discord.membersIntent,
        ping: discord.client.ws.ping,
      };
    }
    if (sim) return { kind: 'simulator', online: true, user: sim.gateway.botUser(), guilds: 1, membersIntent: true };
    return { kind: 'offline', online: false, error: discordError };
  };

  let web = null;
  if (config.web.enabled) {
    try {
      web = await startWeb({ engine, config, log: log.child('web'), sim, getBotInfo });
      const url = `http://${config.web.host === '0.0.0.0' ? 'localhost' : config.web.host}:${web.port}`;
      log.info(`Panel web: ${url}${url !== config.web.publicUrl ? ` (público: ${config.web.publicUrl})` : ''}`);
      if (demo) log.info('Contraseña del panel (demo): demo');
      else if (config.web.passwordFile && config.platform !== 'local') {
        // En la nube no se puede abrir el archivo fácilmente: se muestra una vez y se pide fijarla.
        if (config.web.passwordGenerated) log.warn(`Contraseña del panel generada: ${config.web.password}`);
        log.warn('Define la variable DASHBOARD_PASSWORD en la plataforma para elegir tu propia contraseña del panel.');
      } else if (config.web.passwordFile) {
        log.info(`Contraseña del panel guardada en: ${config.web.passwordFile}${config.web.passwordGenerated ? ' (generada ahora)' : ''}`);
      }
      if (config.platform === 'railway' && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
        log.warn('Railway: no hay un volumen montado. La base de datos se perderá en cada despliegue. Añade un volumen (Settings › Volumes) montado en /data.');
      }
    } catch (err) {
      log.error(`No se pudo iniciar el panel web en el puerto ${config.web.port}: ${err.code === 'EADDRINUSE' ? 'el puerto ya está en uso (cambia DASHBOARD_PORT)' : err.message}`);
    }
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log.info('Apagando…');
    clearTimeout(retryTimer);
    engine.stop();
    try {
      await engine.tasks.flushDirty();
    } catch {
      /* ignorar */
    }
    if (web) await web.close().catch(() => {});
    if (discord) await discord.stop().catch(() => {});
    db.close();
    log.info('Apagado completo.');
    log.close();
  };

  if (handleSignals) {
    // Salida ordenada: se cierra todo y Node termina solo; si algo lo retiene, se fuerza a los 3 s.
    const exitSoon = (code) => {
      process.exitCode = code;
      setTimeout(() => process.exit(code), 3000).unref();
    };
    const onSignal = (sig) => {
      log.info(`Señal ${sig} recibida.`);
      stop().finally(() => exitSoon(0));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.on('unhandledRejection', (reason) => log.error('Promesa rechazada sin controlar:', reason));
    process.on('uncaughtException', (err) => {
      log.error('Excepción no controlada (el bot se reiniciará si usas iniciar.bat o pm2):', err);
      stop().finally(() => exitSoon(1));
    });
  }

  return { config, log, engine, db, x, sim, web, get discord() { return discord; }, getBotInfo, stop };
}

if (require.main === module) {
  const demo = process.argv.includes('--demo');
  main({ demo }).catch((err) => {
    console.error('Error fatal al iniciar:', err);
    process.exit(1);
  });
}

module.exports = { main };
