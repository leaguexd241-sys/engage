'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../src/db/database');
const { Engine } = require('../src/core/engine');
const { XService } = require('../src/twitter/service');
const { MockX } = require('../src/twitter/providers/mock');
const { Logger } = require('../src/logger');

const G = '100000000000000001';
const CH = '200000000000000001';
const LOG_CH = '200000000000000002';
const ROLE = '300000000000000001';

let seq = 0;
const uid = () => String(400000000000000000n + BigInt(++seq));

function silentLogger() {
  return new Logger({ level: 'silent' });
}

function tmpDir(prefix = 'engage-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Publicador que guarda todo lo que el núcleo intenta enviar a Discord. */
function recordingPublisher() {
  const calls = [];
  let msg = 900000000000000000n;
  return {
    calls,
    online: true,
    roleMembers: null,
    async postTask(task) {
      calls.push({ type: 'postTask', taskId: task.id });
      msg += 1n;
      return { channelId: task.channelId, messageId: String(msg) };
    },
    async updateTask(task, view) {
      calls.push({ type: 'updateTask', taskId: task.id, status: task.status, view });
    },
    async deleteTaskMessage(task) {
      calls.push({ type: 'deleteTaskMessage', taskId: task.id });
    },
    async sendReminder(task, users, mode) {
      calls.push({ type: 'sendReminder', taskId: task.id, users: users.map((u) => u.id), mode });
      return { sent: 1, dms: 0 };
    },
    async sendReport(task, summary) {
      calls.push({ type: 'sendReport', taskId: task.id, summary });
    },
    async reviewRequest(task, sub) {
      calls.push({ type: 'reviewRequest', taskId: task.id, subId: sub.id });
      return { channelId: LOG_CH, messageId: '800000000000000001' };
    },
    async reviewDecided(task, sub, decided) {
      calls.push({ type: 'reviewDecided', subId: sub.id, decided });
    },
    async logEvent() {},
    of(type) {
      return calls.filter((c) => c.type === type);
    },
  };
}

/** Motor completo con base de datos en memoria y X simulado. */
function createEngine({ settings = {}, dataDir = null, roleMembers = null } = {}) {
  const log = silentLogger();
  const db = openDatabase(':memory:');
  const mock = new MockX();
  const x = new XService({ providers: [mock.provider], logger: log });
  const engine = new Engine({ db, x, log, dataDir });
  const publisher = recordingPublisher();
  engine.setPublisher(publisher);
  if (roleMembers) {
    engine.setGateway({
      getRoleMembers: async (guildId, roleId) => (roleId === ROLE ? roleMembers.map((id) => ({ id, name: `user-${id.slice(-3)}`, bot: false })) : []),
    });
  }
  engine.store.upsertGuild({ id: G, name: 'Test' });
  engine.updateSettings(G, { tasksChannelId: CH, ...settings });
  mock.addProfile({ handle: 'marca', name: 'Marca' });
  const brand = mock.addTweet({ handle: 'marca', text: 'Lanzamos el nuevo cohete Starship desde Starbase esta semana, ¿qué esperáis del vuelo?' });
  return {
    engine,
    mock,
    db,
    publisher,
    brand,
    close() {
      engine.stop();
      db.close();
    },
  };
}

/** Crea un usuario con su cuenta de X simulada, ya vinculada y verificada. */
async function linkedUser(ctx, name, { verify = true } = {}) {
  const user = { id: uid(), username: name, displayName: name };
  const handle = `${name}_x`.slice(0, 15);
  ctx.mock.addProfile({ handle, name });
  ctx.engine.store.touchMember(G, user);
  if (verify) {
    const { code } = ctx.engine.links.start(user, G, handle);
    ctx.mock.setBio(handle, `bio ${code}`);
    await ctx.engine.links.verifyBio(user);
  }
  return { ...user, handle };
}

function reply(ctx, user, task, text) {
  return ctx.mock.addTweet({ handle: user.handle, text: `@marca ${text}`, replyTo: task.tweetId });
}

const GOOD = [
  'Qué ganas de ver el Starship despegar desde Starbase, será un vuelo histórico para todos',
  'Espero que esta vez el vuelo del cohete salga perfecto y veamos la recuperación completa',
  'El nuevo Starship es impresionante, seguiré el lanzamiento en directo desde casa con mi familia',
  'Starbase está haciendo historia, ojalá el despegue sea un éxito total esta semana',
];

module.exports = { G, CH, LOG_CH, ROLE, uid, tmpDir, silentLogger, recordingPublisher, createEngine, linkedUser, reply, GOOD };
