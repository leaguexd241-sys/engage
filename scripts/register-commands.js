'use strict';

/**
 * Registra (o actualiza) los comandos de barra en Discord.
 * El bot ya lo hace solo al arrancar si detecta cambios; esto sirve para forzarlo.
 *   npm run comandos            → globales (todos los servidores)
 *   npm run comandos -- borrar  → quita los comandos del servidor de pruebas (DEV_GUILD_ID)
 */
const { REST, Routes } = require('discord.js');
const { buildConfig } = require('../src/config');
const { registerCommands } = require('../src/discord/client');
const { openDatabase } = require('../src/db/database');
const { Store } = require('../src/core/store');
const { Logger } = require('../src/logger');

async function main() {
  const config = buildConfig();
  const log = new Logger({ level: 'info', scope: 'comandos' });
  const { token, devGuildId } = config.discord;
  if (!token) {
    log.error('Falta DISCORD_TOKEN en .env');
    process.exit(1);
  }
  const rest = new REST({ version: '10' }).setToken(token);
  const me = await rest.get(Routes.user());
  const clientId = config.discord.clientId || me.id;
  if (process.argv.includes('borrar')) {
    if (!devGuildId) throw new Error('Define DEV_GUILD_ID para borrar los comandos de ese servidor');
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body: [] });
    log.info(`Comandos del servidor ${devGuildId} eliminados.`);
    return;
  }
  const db = openDatabase(config.dbFile);
  const r = await registerCommands({ token, clientId, devGuildId, store: new Store(db), log, force: true });
  db.close();
  log.info(`${r.count} comandos registrados ${devGuildId ? `en el servidor ${devGuildId} (al instante)` : 'globalmente (pueden tardar unos minutos en aparecer)'}.`);
}

main().catch((err) => {
  console.error('No se pudieron registrar los comandos:', err.message);
  process.exit(1);
});
