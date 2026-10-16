'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LruCache } = require('../src/util/lru');
const { Cooldown, WindowLimiter, KeyedLock } = require('../src/util/ratelimit');
const { ConcurrencyLimiter, BusyError, mapLimit } = require('../src/util/limiter');
const { parseDuration, formatDuration, clampDuration, discordTs } = require('../src/util/time');
const text = require('../src/util/text');
const { randomCode, isSnowflake } = require('../src/util/ids');

test('LruCache respeta el tamaño máximo y el orden de uso', () => {
  const c = new LruCache({ max: 3, ttlMs: 10_000 });
  c.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(c.get('a'), 1); // "a" pasa a ser el más reciente
  c.set('d', 4);
  assert.equal(c.get('b'), undefined, 'se expulsa el menos usado');
  assert.equal(c.size, 3);
  for (let i = 0; i < 10_000; i++) c.set(`k${i}`, i);
  assert.equal(c.size, 3, 'nunca crece por encima del máximo');
});

test('LruCache caduca las entradas', async () => {
  const c = new LruCache({ max: 10, ttlMs: 20 });
  c.set('x', 1);
  assert.equal(c.get('x'), 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.get('x'), undefined);
  c.set('y', 1, 5);
  await new Promise((r) => setTimeout(r, 10));
  c.prune();
  assert.equal(c.size, 0);
});

test('Cooldown bloquea y libera', async () => {
  const cd = new Cooldown();
  assert.equal(cd.hit('u', 30), 0);
  assert.ok(cd.hit('u', 30) > 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cd.hit('u', 30), 0);
});

test('WindowLimiter limita intentos por ventana', () => {
  const l = new WindowLimiter({ windowMs: 1000, max: 3 });
  assert.equal(l.check('ip'), true);
  assert.equal(l.check('ip'), true);
  assert.equal(l.check('ip'), true);
  assert.equal(l.check('ip'), false);
  assert.ok(l.retryAfter('ip') > 0);
  l.reset('ip');
  assert.equal(l.check('ip'), true);
});

test('KeyedLock evita ejecuciones paralelas y siempre libera', async () => {
  const lock = new KeyedLock();
  let release;
  const p = lock.run('k', () => new Promise((r) => (release = r)));
  const busy = await lock.run('k', async () => 1);
  assert.equal(busy.busy, true);
  release(5);
  assert.deepEqual(await p, { busy: false, value: 5 });
  await assert.rejects(lock.run('k', async () => Promise.reject(new Error('x'))));
  assert.equal(lock.size, 0, 'se libera aunque falle');
});

test('ConcurrencyLimiter respeta la concurrencia y la cola máxima', async () => {
  const lim = new ConcurrencyLimiter(2, 3);
  let active = 0;
  let peak = 0;
  const job = () =>
    lim.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 1;
    });
  const jobs = [job(), job(), job(), job(), job()];
  await assert.rejects(job(), BusyError);
  assert.deepEqual(await Promise.all(jobs), [1, 1, 1, 1, 1]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapLimit([1, 2, 3, 4], 2, async (x) => x * 2), [2, 4, 6, 8]);
});

test('parseDuration entiende formatos habituales', () => {
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('45m'), 45);
  assert.equal(parseDuration('2h'), 120);
  assert.equal(parseDuration('1h30m'), 90);
  assert.equal(parseDuration('1d 6h'), 1800);
  assert.equal(parseDuration('1,5h'), 90);
  assert.equal(parseDuration('2 horas'), 120);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(parseDuration('-5m'), null);
  assert.equal(clampDuration(1), 5);
  assert.equal(clampDuration(10 ** 9), 43200);
  assert.equal(formatDuration(90), '1 h 30 min');
  assert.equal(formatDuration(1440), '1 d');
  assert.equal(formatDuration(0), '0 min');
  assert.equal(discordTs(1_700_000_000_500, 'R'), '<t:1700000000:R>');
});

test('utilidades de texto', () => {
  assert.equal(text.normalizeForCompare('¡Hola @pepe! Mira https://x.com 🔥 Café'), 'hola mira cafe');
  assert.equal(text.stripLeadingMentions('@a @b_c hola @d'), 'hola @d');
  assert.equal(text.truncate('abcdef', 4), 'abc…');
  assert.equal(text.truncate('🔥🔥🔥', 3), '🔥…', 'no rompe emojis');
  assert.ok(text.truncate('🔥'.repeat(3000), 4096).length <= 4096, 'respeta el límite en unidades UTF-16');
  assert.equal(text.escapeMd('*negrita* _x_ @everyone <@123>'), '\\*negrita\\* \\_x\\_ @​everyone <​@123\\>');
  assert.equal(text.progressBar(0.5, 4), '▰▰▱▱');
  assert.equal(text.progressBar(NaN, 2), '▱▱');
  assert.equal(text.pct(1, 3), 33);
  assert.equal(text.pct(1, 0), 0);
  assert.match(text.quoteBlock('línea 1\nlínea 2'), /^> línea 1\n> línea 2$/);
});

test('ids', () => {
  const c = randomCode(8);
  assert.match(c, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(isSnowflake('123456789012345678'), true);
  assert.equal(isSnowflake('abc'), false);
});
