'use strict';

/**
 * Pruebas contra X REAL (sin API oficial). Necesitan Internet.
 * Ejecuta: npm run test:live
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../../src/db/database');
const { Engine } = require('../../src/core/engine');
const { XService } = require('../../src/twitter/service');
const { buildConfig } = require('../../src/config');
const { createFxTwitterProvider } = require('../../src/twitter/providers/fxtwitter');
const { createSyndicationProvider } = require('../../src/twitter/providers/syndication');
const { recordingPublisher, silentLogger, G, CH, uid } = require('../helpers');

// Post público de @XDevelopers y una respuesta real de la misma cuenta a ese post.
const PARENT = '1623467617037221889';
const REPLY = '1623467618400374784';

const config = buildConfig({ overrides: { dataDir: require('node:os').tmpdir(), logToFile: false } });
const opts = { timeoutMs: 15000, userAgent: config.twitter.userAgent };

test('fxtwitter lee posts y perfiles reales', async () => {
  const p = createFxTwitterProvider(opts);
  const t = await p.getTweet('20');
  assert.equal(t.author.handle, 'jack');
  assert.equal(t.text, 'just setting up my twttr');
  assert.ok(t.metrics.likes > 100000);
  const prof = await p.getProfile('XDevelopers');
  assert.equal(prof.handle.toLowerCase(), 'xdevelopers');
  await assert.rejects(p.getTweet('1'), (e) => e.code === 'NOT_FOUND');
});

test('syndication (el endpoint de los embeds de X) lee posts reales', async () => {
  const p = createSyndicationProvider(opts);
  const t = await p.getTweet(REPLY);
  assert.equal(t.author.handle, 'XDevelopers');
  assert.equal(t.replyTo.id, PARENT);
  await assert.rejects(p.getTweet('1'), (e) => ['NOT_FOUND', 'UNAVAILABLE'].includes(e.code));
});

test('timeline público real: devuelve publicaciones del perfil', async (t) => {
  const p = createSyndicationProvider(opts);
  let tl;
  try {
    tl = await p.getTimeline('NASA');
  } catch (err) {
    // X limita este endpoint con frecuencia; el bot lo gestiona pasando al modo de prueba configurado.
    if (err.code === 'RATE_LIMITED') return t.skip('X pidió esperar (límite de peticiones) — comportamiento esperado y controlado');
    throw err;
  }
  assert.ok(tl.items.length > 0, 'el perfil tiene publicaciones visibles');
  const repost = tl.items.find((i) => i.kind === 'repost');
  if (repost) {
    const svc = new XService({ providers: [p] });
    assert.equal((await svc.findInTimeline('NASA', repost.repostOf, 'repost')).found, true);
  }
});

test('verificación real de extremo a extremo: una respuesta pública de X se comprueba sin API', async (t) => {
  const log = silentLogger();
  const db = openDatabase(':memory:');
  const x = XService.fromConfig(config, log);
  const engine = new Engine({ db, x, log });
  t.after(() => {
    engine.stop();
    db.close();
  });
  engine.setPublisher(recordingPublisher());
  engine.store.upsertGuild({ id: G, name: 'Live' });
  engine.updateSettings(G, { tasksChannelId: CH, verification: { antiDuplicate: false } });
  const task = await engine.tasks.create({ guildId: G, tweetUrl: `https://x.com/XDevelopers/status/${PARENT}`, actions: ['reply'] });
  assert.equal(task.tweet.author.handle, 'XDevelopers');

  // Un miembro con la cuenta @XDevelopers vinculada (por el staff, para la prueba)
  const member = { id: uid(), username: 'dev' };
  engine.links.adminLink({ userId: member.id, handleInput: 'XDevelopers', guildId: G });
  const ok = await engine.verification.verify({ task, user: member, inputs: { reply: `https://x.com/XDevelopers/status/${REPLY}` } });
  assert.equal(ok.results[0].state, 'verified', ok.results[0].message);
  assert.ok(ok.results[0].quality >= 35);
  assert.equal(ok.completedNow, true);

  // Otro miembro intenta usar la respuesta de @XDevelopers como si fuera suya
  const cheater = { id: uid(), username: 'tramposo' };
  engine.links.adminLink({ userId: cheater.id, handleInput: 'jack', guildId: G });
  const bad = await engine.verification.verify({ task, user: cheater, inputs: { reply: `https://x.com/XDevelopers/status/${REPLY}` } });
  assert.equal(bad.results[0].state, 'rejected');
  assert.match(bad.results[0].message, /belongs to @XDevelopers/);

  // Un post que no es respuesta a la tarea
  const wrong = await engine.verification.verify({ task, user: cheater, inputs: { reply: 'https://x.com/jack/status/20' } });
  assert.match(wrong.results[0].message, /is not a reply/);
});
