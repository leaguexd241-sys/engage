'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { DiscordGateway } = require('../src/discord/gateway');
const { DiscordPublisher } = require('../src/discord/publisher');
const { inviteUrl } = require('../src/discord/client');
const { Store } = require('../src/core/store');
const { openDatabase } = require('../src/db/database');
const { withDefaults } = require('../src/core/settings');

/** Cliente con la misma forma que el de discord.js (cachés = Collection, fetch async…). */
function fakeClient({ canPost = true } = {}) {
  const sent = [];
  const perms = new PermissionsBitField(canPost ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] : [PermissionFlagsBits.ViewChannel]);
  const guild = {
    id: '1',
    name: 'Servidor',
    memberCount: 3,
    iconURL: () => 'https://cdn.discordapp.com/icons/1/a.png',
    members: {
      me: { id: 'bot' },
      async fetch(arg) {
        const all = new Collection([
          ['10', { id: '10', displayName: 'Ana', user: { username: 'ana', bot: false }, roles: { cache: new Collection([['R', {}]]) }, displayAvatarURL: () => 'a' }],
          ['11', { id: '11', displayName: 'Bot', user: { username: 'bot', bot: true }, roles: { cache: new Collection([['R', {}]]) }, displayAvatarURL: () => 'b' }],
          ['12', { id: '12', displayName: 'Beto', user: { username: 'beto', bot: false }, roles: { cache: new Collection() }, displayAvatarURL: () => 'c' }],
        ]);
        if (typeof arg === 'string') {
          if (!all.has(arg)) throw new Error('Unknown Member');
          return all.get(arg);
        }
        return all;
      },
    },
    roles: { cache: new Collection([['1', { id: '1', name: '@everyone', position: 0 }], ['R', { id: 'R', name: 'Raiders', hexColor: '#1d9bf0', managed: false, position: 2 }]]) },
    channels: { cache: new Collection() },
  };
  const channel = {
    id: 'C',
    name: 'tareas',
    type: ChannelType.GuildText,
    rawPosition: 1,
    parent: { name: 'Comunidad', rawPosition: 0 },
    guild,
    isTextBased: () => true,
    permissionsFor: () => perms,
    async send(payload) {
      sent.push({ type: 'send', payload });
      return { id: 'M1' };
    },
    messages: {
      async edit(id, payload) {
        if (id === 'gone') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        sent.push({ type: 'edit', id, payload });
      },
      async delete(id) {
        sent.push({ type: 'delete', id });
      },
    },
  };
  guild.channels.cache.set('C', channel);
  guild.channels.cache.set('V', { id: 'V', name: 'voz', type: ChannelType.GuildVoice });
  const client = {
    sent,
    isReady: () => true,
    user: { id: 'bot', tag: 'Bot#0001', username: 'Bot', displayAvatarURL: () => 'x' },
    guilds: { cache: new Collection([['1', guild]]) },
    channels: { fetch: async (id) => (id === 'C' ? channel : null) },
    users: {
      fetch: async (id) => ({
        async send(p) {
          sent.push({ type: 'dm', id, p });
        },
      }),
    },
  };
  return client;
}

test('DiscordGateway usa bien la API de discord.js', async () => {
  const client = fakeClient();
  const gw = new DiscordGateway(client, { membersIntent: true });
  assert.deepEqual(gw.listGuilds(), [{ id: '1', name: 'Servidor', icon: 'https://cdn.discordapp.com/icons/1/a.png', memberCount: 3 }]);
  const ch = gw.listChannels('1');
  assert.equal(ch.length, 1, 'sólo canales de texto');
  assert.equal(ch[0].canPost, true);
  assert.deepEqual(gw.listRoles('1').map((r) => r.name), ['Raiders'], 'sin @everyone');
  const members = await gw.getRoleMembers('1', 'R');
  assert.deepEqual(members.map((m) => [m.id, m.bot]), [['10', false], ['11', true]]);
  assert.deepEqual(await gw.getRoleMembers('1', 'NOPE'), []);
  assert.equal((await gw.getMemberInfo('1', '12')).name, 'Beto');
  assert.equal(await gw.getMemberInfo('1', '99'), null);
  assert.deepEqual(await gw.send('C', { content: 'hola' }), { id: 'M1', channelId: 'C' });
  await gw.edit('C', 'M1', { content: 'x' });
  await gw.delete('C', 'M1');
  assert.equal(await gw.dm('10', { content: 'hola' }), true);
  await assert.rejects(gw.send('X', { content: 'a' }), /no existe/);
  assert.equal(await new DiscordGateway(client, { membersIntent: false }).getRoleMembers('1', 'R'), null, 'sin intent → null (usa el plan B)');
});

test('DiscordGateway explica qué permiso falta', async () => {
  const gw = new DiscordGateway(fakeClient({ canPost: false }));
  await assert.rejects(gw.send('C', { content: 'a' }), /faltan permisos en #tareas: Enviar mensajes, Insertar enlaces/);
  assert.equal(gw.listChannels('1')[0].canPost, false);
});

test('DiscordPublisher: si borraron el mensaje de la tarea deja de editarlo', async () => {
  const db = openDatabase(':memory:');
  const store = new Store(db);
  store.upsertGuild({ id: '1', name: 'S' });
  const task = store.insertTask({ guildId: '1', channelId: 'C', tweetId: '5', tweetUrl: 'https://x.com/a/status/5', tweet: { text: 'hola', author: { handle: 'a' } }, actions: ['like'], points: { like: 1, bonus: 1 }, createdAt: Date.now(), endsAt: Date.now() + 60000 });
  store.updateTask(task.id, { messageId: 'gone' });
  const client = fakeClient();
  const pub = new DiscordPublisher({ gateway: new DiscordGateway(client), store, log: { warn() {}, debug() {} } });
  await pub.updateTask(store.getTask(task.id), { completed: 0, participants: 0, expectedCount: null, settings: withDefaults({}) });
  assert.equal(store.getTask(task.id).messageId, null);
  const r = await pub.sendReminder(store.getTask(task.id), [{ id: '10' }, { id: '12' }], 'both', withDefaults({}));
  assert.equal(r.dms, 2);
  assert.ok(client.sent.some((s) => s.type === 'send' && /Recordatorio/.test(s.payload.content)));
  db.close();
});

test('enlace de invitación con los permisos justos', () => {
  const url = new URL(inviteUrl('123'));
  assert.equal(url.searchParams.get('client_id'), '123');
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  const perms = new PermissionsBitField(BigInt(url.searchParams.get('permissions')));
  for (const p of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'MentionEveryone', 'UseExternalEmojis']) assert.ok(perms.has(p), p);
  assert.ok(!perms.has('Administrator'), 'no pide permisos de administrador');
});
