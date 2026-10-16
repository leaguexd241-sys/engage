'use strict';

const crypto = require('node:crypto');
const { Client, GatewayIntentBits, Options, Events, ActivityType, REST, Routes } = require('discord.js');
const { DiscordGateway } = require('./gateway');
const { DiscordPublisher } = require('./publisher');
const { InteractionHandler } = require('./handlers');
const { commandsJSON } = require('./commands');

const READY_TIMEOUT_MS = 90_000;

function makeClient(withMembers) {
  return new Client({
    intents: [GatewayIntentBits.Guilds, ...(withMembers ? [GatewayIntentBits.GuildMembers] : [])],
    allowedMentions: { parse: [], repliedUser: false },
    // No guardamos mensajes, reacciones ni presencias en memoria: el bot no los necesita.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      GuildStickerManager: 0,
      GuildScheduledEventManager: 0,
      StageInstanceManager: 0,
      VoiceStateManager: 0,
      ThreadMemberManager: 0,
      GuildInviteManager: 0,
      GuildBanManager: 0,
      AutoModerationRuleManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      threads: { interval: 3600, lifetime: 3600 },
    },
  });
}

/** Registra los comandos sólo si cambiaron (Discord limita cuántas veces se puede hacer al día). */
async function registerCommands({ token, clientId, devGuildId, store, log, force = false }) {
  const body = commandsJSON();
  const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  const scope = devGuildId ? `guild:${devGuildId}` : 'global';
  const key = `commands:${clientId}:${scope}`;
  if (!force && store?.kvGet(key) === hash) {
    log.info(`Comandos ya registrados (${scope}), sin cambios.`);
    return { changed: false, count: body.length };
  }
  const rest = new REST({ version: '10' }).setToken(token);
  const route = devGuildId ? Routes.applicationGuildCommands(clientId, devGuildId) : Routes.applicationCommands(clientId);
  await rest.put(route, { body });
  store?.kvSet(key, hash);
  log.info(`Registrados ${body.length} comandos (${scope}).`);
  return { changed: true, count: body.length };
}

function connect(token, withMembers, log) {
  const client = makeClient(withMembers);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off(Events.ShardDisconnect, onDisconnect);
      if (ok) resolve(value);
      else {
        client.destroy().catch(() => {});
        reject(value);
      }
    };
    const onDisconnect = (event) => {
      if (event?.code === 4014) finish(false, Object.assign(new Error('Intent privilegiado no activado'), { code: 'DisallowedIntents' }));
      else if (event?.code === 4004) finish(false, Object.assign(new Error('Token de Discord inválido'), { code: 'TokenInvalid' }));
    };
    client.on(Events.ShardDisconnect, onDisconnect);
    client.once(Events.ClientReady, () => finish(true, client));
    const timer = setTimeout(() => finish(false, new Error('Discord no respondió a tiempo al iniciar sesión')), READY_TIMEOUT_MS);
    client.login(token).catch((err) => finish(false, err));
    log.debug(`Conectando a Discord (intent de miembros: ${withMembers ? 'sí' : 'no'})…`);
  });
}

/**
 * Inicia el bot de Discord y lo conecta al motor.
 * @returns {Promise<{client, gateway, stop: () => Promise<void>}>}
 */
async function startDiscord({ engine, config, log }) {
  const token = config.discord.token;
  let client;
  let membersIntent = true;
  try {
    client = await connect(token, true, log);
  } catch (err) {
    if (err.code !== 'DisallowedIntents') throw err;
    log.warn(
      'El intent "Server Members" no está activado en el portal de desarrolladores. El bot funcionará, pero para saber quién NO hizo la tarea usará los miembros con X vinculada en vez del rol de participantes. Actívalo en https://discord.com/developers/applications › Bot › Privileged Gateway Intents.',
    );
    membersIntent = false;
    client = await connect(token, false, log);
  }

  const gateway = new DiscordGateway(client, { membersIntent, log });
  const publisher = new DiscordPublisher({ gateway, store: engine.store, log: log.child('publisher') });
  const handler = new InteractionHandler({ engine, config, log: log.child('interacciones') });
  engine.setGateway(gateway);
  engine.setPublisher(publisher);

  log.info(`Conectado como ${client.user.tag} en ${client.guilds.cache.size} servidor(es).`);
  for (const g of client.guilds.cache.values()) engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) });
  client.user.setPresence({ activities: [{ name: 'tareas de engagement en X', type: ActivityType.Watching }], status: 'online' });

  client.on(Events.InteractionCreate, (interaction) => {
    handler.handle(interaction).catch((err) => log.error('Error no controlado en una interacción:', err));
  });
  client.on(Events.GuildCreate, (g) => {
    engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) });
    log.info(`Añadido al servidor ${g.name} (${g.id})`);
    engine.bus.change(g.id, 'guild', {});
  });
  client.on(Events.GuildDelete, (g) => {
    engine.store.setGuildActive(g.id, false);
    log.info(`Eliminado del servidor ${g.name || g.id}`);
    engine.bus.change(g.id, 'guild', {});
  });
  client.on(Events.GuildUpdate, (_old, g) => engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) }));
  client.on(Events.Error, (err) => log.error('Error del cliente de Discord:', err));
  client.on(Events.Warn, (msg) => log.warn(`Discord: ${msg}`));
  client.on(Events.ShardDisconnect, (e) => log.warn(`Desconectado de Discord (código ${e?.code}). Reconectando…`));
  client.on(Events.ShardResume, () => log.info('Conexión con Discord recuperada.'));

  const clientId = config.discord.clientId || client.user.id;
  registerCommands({ token, clientId, devGuildId: config.discord.devGuildId, store: engine.store, log }).catch((err) =>
    log.error(`No se pudieron registrar los comandos: ${err.message}`),
  );

  return {
    client,
    gateway,
    membersIntent,
    async stop() {
      engine.setPublisher(null);
      engine.setGateway(null);
      client.removeAllListeners();
      await client.destroy();
    },
  };
}

function inviteUrl(clientId) {
  // Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer historial, Mencionar roles, Emojis externos
  const permissions = 1024 + 2048 + 16384 + 32768 + 65536 + 131072 + 262144;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&integration_type=0&scope=bot+applications.commands`;
}

module.exports = { startDiscord, registerCommands, inviteUrl, makeClient };
