'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSyndicationProvider, syndicationToken } = require('../src/twitter/providers/syndication');
const { createFxTwitterProvider } = require('../src/twitter/providers/fxtwitter');
const { XService } = require('../src/twitter/service');
const { XError } = require('../src/twitter/errors');
const { MockX } = require('../src/twitter/providers/mock');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

/** fetch falso: responde según la URL. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    for (const [re, resp] of routes) {
      if (re.test(url)) {
        if (resp instanceof Error) throw resp;
        const r = typeof resp === 'function' ? resp(url) : resp;
        return new Response(r.body ?? '', { status: r.status ?? 200, headers: { 'content-type': r.type || 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

test('token de syndication igual que el widget oficial', () => {
  assert.equal(syndicationToken('20'), '6dq1a2xwd93');
});

test('syndication normaliza un post con imagen y una respuesta (datos reales)', async () => {
  const fetchImpl = fakeFetch([
    [/id=2103537377239015827/, { body: fx('syndication-media.json') }],
    [/id=1623467618400374784/, { body: fx('syndication-reply.json') }],
  ]);
  const p = createSyndicationProvider({ fetchImpl, timeoutMs: 1000 });
  const t = await p.getTweet('2103537377239015827');
  assert.equal(t.id, '2103537377239015827');
  assert.equal(t.author.handle, 'elonmusk');
  assert.equal(t.text, 'May Starship have the Mandate of Heaven', 'sin el enlace t.co de la imagen');
  assert.equal(t.media[0].type, 'photo');
  assert.match(t.media[0].url, /^https:\/\/pbs\.twimg\.com\/media\//);
  assert.ok(t.metrics.likes > 0);
  assert.equal(t.replyTo, null);
  const r = await p.getTweet('1623467618400374784');
  assert.deepEqual(r.replyTo, { id: '1623467617037221889', handle: 'XDevelopers' });
  assert.equal(r.author.handle, 'XDevelopers');
});

test('fxtwitter normaliza post, respuesta y perfil (datos reales)', async () => {
  const fetchImpl = fakeFetch([
    [/status\/2103537377239015827/, { body: fx('fx-media.json') }],
    [/status\/1623467618400374784/, { body: fx('fx-reply.json') }],
    [/profile\/XDevelopers/, { body: fx('fx-profile.json') }],
  ]);
  const p = createFxTwitterProvider({ fetchImpl, timeoutMs: 1000 });
  const t = await p.getTweet('2103537377239015827');
  assert.equal(t.text, 'May Starship have the Mandate of Heaven');
  assert.ok(Number.isFinite(t.metrics.reposts) && Number.isFinite(t.metrics.views));
  assert.doesNotMatch(t.media[0].url, /name=orig/);
  const r = await p.getTweet('1623467618400374784');
  assert.equal(r.replyTo.id, '1623467617037221889');
  const prof = await p.getProfile('XDevelopers');
  assert.equal(prof.handle, 'XDevelopers');
  assert.equal(typeof prof.description, 'string');
});

test('proveedores: errores bien clasificados', async () => {
  const fetchImpl = fakeFetch([
    [/api\.fxtwitter\.com\/2\/status\/1$/, { status: 404, body: '{"code":404,"message":"NOT_FOUND"}' }],
    [/api\.fxtwitter\.com\/2\/status\/2$/, { status: 401, body: '{"code":401,"message":"PRIVATE_TWEET"}' }],
    [/api\.fxtwitter\.com\/2\/status\/3$/, { status: 500, body: '<html>error</html>', type: 'text/html' }],
    [/api\.fxtwitter\.com\/2\/status\/4$/, new TypeError('fetch failed')],
    [/tweet-result\?id=5&/, { status: 200, body: '' }],
    [/tweet-result\?id=6&/, { body: JSON.stringify({ __typename: 'TweetTombstone', tombstone: { text: { text: 'This account owner limits who can view their Posts' } } }) }],
    [/tweet-result\?id=7&/, { status: 429, body: '' }],
  ]);
  const fxp = createFxTwitterProvider({ fetchImpl, timeoutMs: 500 });
  const sp = createSyndicationProvider({ fetchImpl, timeoutMs: 500 });
  const code = async (p) => p.then(() => 'OK', (e) => (e instanceof XError ? e.code : `OTRO:${e.message}`));
  assert.equal(await code(fxp.getTweet('1')), 'NOT_FOUND');
  assert.equal(await code(fxp.getTweet('2')), 'PROTECTED');
  assert.equal(await code(fxp.getTweet('3')), 'UNAVAILABLE');
  assert.equal(await code(fxp.getTweet('4')), 'UNAVAILABLE');
  assert.equal(await code(sp.getTweet('5')), 'UNAVAILABLE', 'an empty response does not prove the post was deleted');
  assert.equal(await code(sp.getTweet('6')), 'PROTECTED');
  assert.equal(await code(sp.getTweet('7')), 'RATE_LIMITED');
});

test('timeline público: detecta reposts y lee el perfil (datos reales)', async () => {
  const fetchImpl = fakeFetch([[/timeline-profile\/screen-name\/NASA/, { body: fx('timeline-nasa.html'), type: 'text/html' }]]);
  const p = createSyndicationProvider({ fetchImpl, timeoutMs: 1000 });
  const tl = await p.getTimeline('NASA');
  assert.equal(tl.items.length, 6);
  assert.equal(tl.items[0].kind, 'repost');
  assert.equal(tl.items[0].repostOf, '2103928053436989458');
  assert.equal(tl.profile.handle, 'NASA');
  const svc = new XService({ providers: [p] });
  assert.equal((await svc.findInTimeline('NASA', '2103928053436989458', 'repost')).found, true);
  assert.equal((await svc.findInTimeline('NASA', '999', 'repost')).found, false);
});

test('XService: respaldo entre proveedores, caché, deduplicación y caché negativa', async () => {
  let aCalls = 0;
  let bCalls = 0;
  const a = {
    name: 'a',
    async getTweet(id) {
      aCalls += 1;
      if (id === 'down') throw new XError('UNAVAILABLE', 'caído');
      if (id === 'gone') throw new XError('NOT_FOUND');
      await new Promise((r) => setTimeout(r, 20));
      return { id, text: 'a' };
    },
  };
  const b = {
    name: 'b',
    async getTweet(id) {
      bCalls += 1;
      if (id === 'gone') throw new XError('NOT_FOUND');
      return { id, text: 'b' };
    },
  };
  const svc = new XService({ providers: [a, b] });
  // Respaldo: si "a" está caído, responde "b"
  assert.equal((await svc.getTweet('down')).text, 'b');
  // Deduplicación: dos peticiones simultáneas = una llamada
  const [r1, r2] = await Promise.all([svc.getTweet('x'), svc.getTweet('x')]);
  assert.equal(r1.text, 'a');
  assert.equal(r2, r1);
  assert.equal(aCalls, 2);
  // Caché
  await svc.getTweet('x');
  assert.equal(aCalls, 2);
  // fresh ignora la caché
  await svc.getTweet('x', { fresh: true });
  assert.equal(aCalls, 3);
  // Caché negativa para NOT_FOUND
  await assert.rejects(svc.getTweet('gone'), (e) => e.code === 'NOT_FOUND');
  const before = bCalls;
  await assert.rejects(svc.getTweet('gone'), (e) => e.code === 'NOT_FOUND');
  assert.equal(bCalls, before, 'no vuelve a preguntar enseguida');
  const st = svc.status();
  assert.equal(st.inflight, 0, 'no quedan peticiones colgando');
  assert.ok(st.providers.find((p) => p.name === 'a').fail >= 1);
});

test('XService: si una fuente dice "no existe" y otra está caída, el error es reintentable', async () => {
  const svc = new XService({
    providers: [
      { name: 'a', getTweet: async () => Promise.reject(new XError('NOT_FOUND')) },
      { name: 'b', getTweet: async () => Promise.reject(new XError('UNAVAILABLE')) },
    ],
  });
  await assert.rejects(svc.getTweet('1'), (e) => e.code === 'UNAVAILABLE');
});

test('MockX: se comporta como X', async () => {
  const m = new MockX();
  m.addProfile({ handle: 'a' });
  const t = m.addTweet({ handle: 'a', text: 'hola' });
  const r = m.addTweet({ handle: 'a', text: '@a respuesta', replyTo: t.id });
  const got = await m.provider.getTweet(r.id);
  assert.equal(got.text, 'respuesta', 'sin la mención inicial, como las fuentes reales');
  assert.equal(got.replyTo.id, t.id);
  assert.equal((await m.provider.getTweet(t.id)).metrics.replies, 1);
  await assert.rejects(m.provider.getTweet('123'), (e) => e.code === 'NOT_HANDLED');
  m.repost('a', t.id);
  assert.equal((await m.provider.getTimeline('a')).items[0].repostOf, t.id);
  m.failNext = 'UNAVAILABLE';
  await assert.rejects(m.provider.getTweet(t.id), (e) => e.code === 'UNAVAILABLE');
});

test('XService: pausa una fuente que pide esperar (429) y usa las demás', async () => {
  let aCalls = 0;
  const svc = new XService({
    providers: [
      { name: 'a', getTweet: async () => { aCalls += 1; throw new XError('RATE_LIMITED'); } },
      { name: 'b', getTweet: async (id) => ({ id, text: 'b' }) },
    ],
  });
  assert.equal((await svc.getTweet('1')).text, 'b');
  assert.equal((await svc.getTweet('2')).text, 'b');
  assert.equal(aCalls, 1, 'no insiste con la fuente pausada');
  assert.equal(svc.status().providers[0].paused.length, 1);
  const solo = new XService({ providers: [{ name: 'a', getTimeline: async () => { throw new XError('RATE_LIMITED'); } }] });
  assert.deepEqual(await solo.findInTimeline('u', '1', 'repost'), { found: false, checked: false, error: 'RATE_LIMITED' });
  assert.deepEqual(await solo.findInTimeline('v', '1', 'repost'), { found: false, checked: false, error: 'RATE_LIMITED' });
});
