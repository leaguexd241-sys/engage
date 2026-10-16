'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActionRowBuilder, ModalBuilder } = require('discord.js');
const ui = require('../src/discord/ui');
const { validateMessage } = require('../src/sim/validate');
const { validateModal } = require('../src/sim/interaction');
const { withDefaults } = require('../src/core/settings');
const { commandsJSON } = require('../src/discord/commands');

const settings = withDefaults({});
const LONG = '🔥'.repeat(50) + ' ' + 'palabra_con_guiones-bajos **negrita** '.repeat(200);

/** Valida con nuestras reglas (límites de la API) y con los validadores de discord.js. */
function check(payload, opts) {
  validateMessage(payload, opts);
  for (const row of payload.components || []) new ActionRowBuilder(row).toJSON();
  return payload;
}

function bigTask(overrides = {}) {
  return {
    id: 123,
    guildId: '100000000000000001',
    channelId: '200000000000000001',
    messageId: '300000000000000001',
    status: 'active',
    tweetId: '1623467618400374784',
    tweetUrl: 'https://x.com/XDevelopers/status/1623467618400374784',
    tweet: {
      text: LONG,
      author: { handle: 'un_usuario_largo', name: 'N'.repeat(300), avatar: 'https://pbs.twimg.com/a.jpg' },
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }, { type: 'photo', url: 'https://pbs.twimg.com/media/y.jpg' }],
    },
    actions: ['like', 'repost', 'reply', 'quote'],
    points: { like: 1, repost: 2, reply: 3, quote: 3, bonus: 2 },
    note: LONG,
    pingRoleId: '400000000000000001',
    roleId: '400000000000000002',
    createdAt: Date.now(),
    endsAt: Date.now() + 3600_000,
    closedAt: null,
    flags: [{ message: 'x'.repeat(2000) }],
    report: { revoked: 3 },
    ...overrides,
  };
}

function manyUsers(n, prefix = 'u') {
  return Array.from({ length: n }, (_, i) => ({ id: String(500000000000000000n + BigInt(i)), name: `${prefix}${i}`, done: 1, total: 3, actions: {} }));
}

function summary(n = 3000) {
  return {
    expectedSource: 'role',
    expectedCount: n * 4,
    participants: n * 3,
    completed: manyUsers(n, 'c'),
    pending: manyUsers(n, 'p'),
    partial: manyUsers(n, 'x'),
    missing: manyUsers(n, 'm'),
    notCompletedCount: n * 3,
    completionRate: 25,
    perAction: { like: { verified: 10, pending: 2, rejected: 1, byMethod: {} }, repost: { verified: 1, pending: 0, rejected: 0, byMethod: {} }, reply: { verified: 1, pending: 0, rejected: 0, byMethod: {} }, quote: { verified: 0, pending: 0, rejected: 0, byMethod: {} } },
    avgQuality: 77,
  };
}

test('mensaje de tarea con datos extremos respeta los límites de Discord', () => {
  for (const status of ['active', 'closed', 'cancelled']) {
    for (const messageId of [null, '1']) {
      const p = check(ui.taskMessage(bigTask({ status, messageId, closedAt: Date.now() }), { completed: 5000, participants: 9000, expectedCount: 10000, settings }));
      if (status === 'active' && !messageId) assert.match(p.content, /<@&400000000000000001>/);
      if (messageId) assert.equal(p.content, undefined, 'al editar no se toca el texto');
    }
  }
  const noMedia = bigTask({ tweet: { text: '', author: {}, media: [] }, note: null, pingRoleId: null });
  check(ui.taskMessage(noMedia, { completed: 0, participants: 0, expectedCount: null, settings }));
  assert.equal(ui.taskMessage(noMedia, { completed: 0, participants: 0, expectedCount: 0, settings }).embeds[0].fields.at(-1).value.includes('completed'), true);
});

test('informe, estado y recordatorios con miles de miembros', () => {
  const task = bigTask({ status: 'closed', closedAt: Date.now() });
  const s = summary(3000);
  for (const mentionMissing of [false, true]) {
    const p = check(ui.reportMessage(task, s, { ...settings, report: { ...settings.report, mentionMissing } }));
    if (mentionMissing) assert.ok(p.allowedMentions.users.length <= 100);
  }
  const st = check(ui.statusMessage(task, s));
  assert.match(JSON.stringify(st), /… and \d+ more/);
  const reminders = ui.reminderMessages(task, manyUsers(3000));
  assert.ok(reminders.length <= 5);
  for (const r of reminders) {
    check(r);
    assert.ok(r.allowedMentions.users.length <= 100);
  }
  check(ui.reminderDM(task, 'Servidor'));
});

test('resto de mensajes', () => {
  const task = bigTask();
  const items = task.actions.map((action, i) => ({ action, status: ['verified', 'pending', 'awaiting', 'rejected'][i], sub: { method: 'auto', quality: 80, reason: LONG } }));
  const progress = { items, done: 1, total: 4, complete: false, state: 'pending' };
  check(ui.progressMessage(task, progress, { results: task.actions.map((action) => ({ action, state: 'rejected', message: LONG })), pointsEarned: 12 }));
  check(ui.progressMessage(task, { ...progress, complete: true, state: 'complete', done: 4 }, { completedNow: true }));
  const sub = { id: 9, userId: '1', action: 'like', method: 'screenshot', updatedAt: Date.now() };
  check(ui.reviewMessage(task, sub, { xHandle: 'x' }, 'https://cdn.discordapp.com/a.png'));
  check(ui.reviewMessage(task, sub, { xHandle: 'x' }, null, { decided: { approve: false, by: 'staff', reason: LONG } }), { edit: true });
  check(ui.reviewResultDM(task, sub, false, LONG));
  check(ui.linkStartMessage({ handle: 'usuario', code: 'ENG-ABC234', tweetIntent: 'https://x.com/intent/post?text=a', expiresAt: Date.now(), allowUnverified: true }));
  check(ui.linkedMessage({ handle: 'usuario', verified: true, protected: true, xAvatar: 'https://pbs.twimg.com/a.jpg' }));
  check(ui.needLinkMessage(true));
  check(ui.profileMessage({ user: { username: 'a', displayName: 'N'.repeat(400) }, member: { points: 10, trust: 90, streak: 3, bestStreak: 5, completed: 4, missed: 1, rejected: 0, blacklisted: true }, link: null, rank: 2 }));
  check(ui.leaderboardMessage([], { title: 'Ranking' }));
  check(ui.leaderboardMessage(Array.from({ length: 10 }, (_, i) => ({ user_id: String(i + 1), points: 100 - i, completed: i, streak: i, x_handle: 'h_i' })), { title: 'Ranking', guildName: 'G' }));
  check(ui.taskListMessage(Array.from({ length: 40 }, (_, i) => bigTask({ id: i + 1 })), { completedBy: new Map([[1, true]]) }));
  check(ui.taskListMessage([]));
  check(ui.configMessage(settings, { dashboardUrl: 'http://localhost:3000' }));
  check(ui.helpMessage({ staff: true, dashboardUrl: 'http://localhost:3000' }));
  check(ui.errorMessage(LONG));
  check(ui.successMessage('ok'));
});

test('los formularios (modales) son válidos para Discord y discord.js', () => {
  const task = bigTask();
  for (const modal of [ui.verifyModal(task, ['reply', 'quote']), ui.verifyModal(task, ['reply']), ui.linkStartModal(), ui.linkTweetModal(), ui.rejectModal(123)]) {
    validateModal(modal);
    new ModalBuilder(modal).toJSON();
    assert.ok(modal.custom_id.length <= 100);
  }
});

test('mentionList corta a tiempo y cuenta el resto', () => {
  const out = ui.mentionList(manyUsers(500), 200);
  assert.ok(out.length <= 220);
  assert.match(out, /… and \d+ more$/);
  assert.equal(ui.mentionList([]), '—');
});

test('los comandos cumplen los límites de Discord', () => {
  const cmds = commandsJSON();
  assert.ok(cmds.length <= 100);
  for (const c of cmds) {
    assert.match(c.name, /^[a-z0-9_-]{1,32}$/);
    assert.ok(c.description.length <= 100);
    assert.ok(JSON.stringify(c).length < 8000);
  }
});
