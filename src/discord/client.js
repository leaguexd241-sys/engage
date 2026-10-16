'use strict';

const crypto = require('node:crypto');
const { Client, GatewayIntentBits, Options, Events, ActivityType, REST, Routes, ApplicationFlagsBitField } = require('discord.js');
const { DiscordGateway } = require('./gateway');
const { DiscordPublisher } = require('./publisher');
const { InteractionHandler } = require('./handlers');
const { commandsJSON } = require('./commands');

const READY_TIMEOUT_MS = 90_000;

function makeClient(withMembers) {
  return new Client({
    rest: { timeout: 15_000, retries: 1 },
    intents: [GatewayIntentBits.Guilds, ...(withMembers ? [GatewayIntentBits.GuildMembers] : [])],
    allowedMentions: { parse: [], repliedUser: false },
    // No guardamos mensajes, reacciones ni presencias en memoria: el bot no los necesita.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      UserManager: 2000,
      GuildMemberManager: { maxSize: 200, keepOverLimit: (m) => m.id === m.client.user?.id },
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

function connect(token, withMembers, log, signal) {
  const client = makeClient(withMembers);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off(Events.ShardDisconnect, onDisconnect);
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
      signal?.removeEventListener('abort', onAbort);
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
    const onReady = () => finish(true, client);
    const onError = (err) => finish(false, err);
    const onAbort = () => finish(false, new Error('Discord connection cancelled'));
    client.on(Events.ShardDisconnect, onDisconnect);
    client.once(Events.ClientReady, onReady);
    client.on(Events.Error, onError);
    const timer = setTimeout(() => finish(false, new Error('Discord no respondió a tiempo al iniciar sesión')), READY_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    client.login(token).catch((err) => finish(false, err));
    log.debug(`Conectando a Discord (intent de miembros: ${withMembers ? 'sí' : 'no'})…`);
  });
}

function membersIntentEnabled(flags) {
  const bits = new ApplicationFlagsBitField(flags ?? 0);
  return bits.has(ApplicationFlagsBitField.Flags.GatewayGuildMembers) || bits.has(ApplicationFlagsBitField.Flags.GatewayGuildMembersLimited);
}

/**
 * Inicia el bot de Discord y lo conecta al motor.
 * @returns {Promise<{client, gateway, stop: () => Promise<void>}>}
 */
async function startDiscord({ engine, config, log, connectClient = connect, register = registerCommands }) {
  const token = config.discord.token;
  let client;
  let membersIntent = true;
  try {
    client = await connectClient(token, true, log);
  } catch (err) {
    if (err.code !== 'DisallowedIntents') throw err;
    log.warn(
      'Discord denied the Server Members intent at login. Temporarily using linked X accounts for participation. The portal setting will be checked every minute; the bot reconnects when access is enabled.',
    );
    membersIntent = false;
    client = await connectClient(token, false, log);
  }

  const gateway = new DiscordGateway(client, { membersIntent, log });
  const intentStatus = { portalEnabled: membersIntent ? true : null, active: membersIntent, checkedAt: null, error: null, reconnecting: false };
  const lifecycle = new AbortController();
  let stopped = false;
  let checkTimer = null;
  let checking = null;
  const publisher = new DiscordPublisher({ gateway, store: engine.store, log: log.child('publisher') });
  const handler = new InteractionHandler({ engine, config, log: log.child('interacciones') });
  engine.setGateway(gateway);
  engine.setPublisher(publisher);

  log.info(`Conectado como ${client.user.tag} en ${client.guilds.cache.size} servidor(es).`);
  for (const g of client.guilds.cache.values()) engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) });
  const bindClient = (activeClient) => {
    activeClient.user.setPresence({ activities: [{ name: 'X engagement tasks', type: ActivityType.Watching }], status: 'online' });

    activeClient.on(Events.InteractionCreate, (interaction) => {
      handler.handle(interaction).catch((err) => log.error('Error no controlado en una interacción:', err));
    });
    activeClient.on(Events.GuildCreate, (g) => {
      engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) });
      log.info(`Añadido al servidor ${g.name} (${g.id})`);
      engine.bus.change(g.id, 'guild', {});
    });
    activeClient.on(Events.GuildDelete, (g) => {
      engine.store.setGuildActive(g.id, false);
      log.info(`Eliminado del servidor ${g.name || g.id}`);
      engine.bus.change(g.id, 'guild', {});
    });
    activeClient.on(Events.GuildUpdate, (_old, g) => engine.store.upsertGuild({ id: g.id, name: g.name, icon: g.iconURL({ size: 128 }) }));
    activeClient.on(Events.Error, (err) => log.error('Error del cliente de Discord:', err));
    activeClient.on(Events.Warn, (msg) => log.warn(`Discord: ${msg}`));
    activeClient.on(Events.ShardDisconnect, (e) => log.warn(`Desconectado de Discord (código ${e?.code}). Reconectando…`));
    activeClient.on(Events.ShardResume, () => log.info('Conexión con Discord recuperada.'));
  };
  bindClient(client);

  // The portal switch and the intents of an existing Gateway session are separate
  // states. Re-read the application's flags and replace a fallback session when
  // members access becomes available, without waiting for a Railway restart.
  const refreshMembersIntent = () => {
    if (stopped) return Promise.resolve({ ...intentStatus });
    if (checking) return checking;
    checking = (async () => {
      try {
        const application = await client.application.fetch();
        if (stopped) return { ...intentStatus };
        intentStatus.portalEnabled = membersIntentEnabled(application.flags);
        intentStatus.checkedAt = Date.now();
        intentStatus.error = null;
        if (intentStatus.portalEnabled && !membersIntent) {
          intentStatus.reconnecting = true;
          const replacement = await connectClient(token, true, log, lifecycle.signal);
          if (stopped) { await replacement.destroy(); return { ...intentStatus }; }
          const previous = client;
          previous.removeAllListeners(Events.InteractionCreate);
          client = replacement;
          gateway.client = replacement;
          gateway.membersIntent = membersIntent = true;
          intentStatus.active = true;
          bindClient(replacement);
          await previous.destroy().catch(() => {});
          previous.removeAllListeners();
          engine.tasks.roleCache.clear();
          for (const g of client.guilds.cache.values()) engine.bus.change(g.id, 'guild', {});
          log.info('Server Members intent enabled; Discord session updated.');
        }
      } catch (err) {
        if (!stopped) {
          intentStatus.error = err.message;
          log.warn(`Could not refresh Server Members intent: ${err.message}`);
        }
      } finally {
        intentStatus.reconnecting = false;
      }
      return { ...intentStatus };
    })().finally(() => { checking = null; });
    return checking;
  };
  const scheduleCheck = () => {
    checkTimer = setTimeout(async () => {
      await refreshMembersIntent();
      if (!stopped) scheduleCheck();
    }, 60_000);
    checkTimer.unref?.();
  };
  gateway.refreshMembersIntent = refreshMembersIntent;
  gateway.intentStatus = intentStatus;
  scheduleCheck();
  // Run once immediately, including when the first connection used the fallback.
  void refreshMembersIntent();

  const clientId = client.user.id;
  if (config.discord.clientId && config.discord.clientId !== clientId) log.warn('DISCORD_CLIENT_ID does not match the connected bot. Commands will use the authenticated bot ID.');
  register({ token, clientId, devGuildId: config.discord.devGuildId, store: engine.store, log }).catch((err) =>
    log.error(`No se pudieron registrar los comandos: ${err.message}`),
  );

  return {
    get client() { return client; },
    gateway,
    get membersIntent() { return membersIntent; },
    refreshMembersIntent,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(checkTimer);
      lifecycle.abort();
      engine.setPublisher(null);
      engine.setGateway(null);
      await client.destroy();
      await handler.stop();
      client.removeAllListeners();
    },
  };
}

function inviteUrl(clientId) {
  // Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer historial, Mencionar roles, Emojis externos
  const permissions = 1024 + 2048 + 16384 + 32768 + 65536 + 131072 + 262144;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&integration_type=0&scope=bot+applications.commands`;
}

module.exports = { startDiscord, registerCommands, inviteUrl, makeClient, membersIntentEnabled };
