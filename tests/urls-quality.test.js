'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTweetUrl, parseHandle, intents, tweetUrl } = require('../src/twitter/urls');
const { analyzeReply } = require('../src/core/quality');
const { similarity, findDuplicate } = require('../src/core/similarity');
const { applyTrust, trustLevel } = require('../src/core/trust');
const { applySettingsPatch, withDefaults, DEFAULT_SETTINGS } = require('../src/core/settings');

test('parseTweetUrl acepta todas las variantes de enlace', () => {
  const id = '1623467618400374784';
  for (const u of [
    `https://x.com/XDevelopers/status/${id}`,
    `https://twitter.com/XDevelopers/status/${id}?s=20&t=abc`,
    `https://mobile.twitter.com/XDevelopers/status/${id}`,
    `x.com/XDevelopers/status/${id}/photo/1`,
    `https://fxtwitter.com/XDevelopers/status/${id}`,
    `https://vxtwitter.com/XDevelopers/status/${id}`,
    `https://fixupx.com/XDevelopers/status/${id}`,
    `<https://x.com/XDevelopers/status/${id}>`,
    `https://nitter.net/XDevelopers/status/${id}#m`,
  ]) {
    assert.deepEqual(parseTweetUrl(u), { id, handle: 'XDevelopers' }, u);
  }
  assert.deepEqual(parseTweetUrl(`https://x.com/i/web/status/${id}`), { id, handle: null });
  assert.deepEqual(parseTweetUrl(id), { id, handle: null });
  for (const bad of ['', null, 'hola', 'https://example.com/a/status/1', 'https://x.com/usuario', 'https://evil.com/x.com/a/status/123', 'javascript:alert(1)']) {
    assert.equal(parseTweetUrl(bad), null, String(bad));
  }
});

test('parseHandle normaliza usuarios', () => {
  assert.equal(parseHandle('@Usuario_1'), 'Usuario_1');
  assert.equal(parseHandle('usuario'), 'usuario');
  assert.equal(parseHandle('https://x.com/usuario'), 'usuario');
  assert.equal(parseHandle('x.com/usuario/status/1'), 'usuario');
  assert.equal(parseHandle('@@doble'), 'doble');
  for (const bad of ['', '@', 'con espacio', 'demasiadolargoparaunhandle', 'https://evil.com/usuario', 'home', 'i']) {
    assert.equal(parseHandle(bad), null, bad);
  }
});

test('intents de X', () => {
  assert.equal(intents.like('1'), 'https://x.com/intent/like?tweet_id=1');
  assert.equal(intents.repost('1'), 'https://x.com/intent/retweet?tweet_id=1');
  assert.equal(intents.reply('1'), 'https://x.com/intent/post?in_reply_to=1');
  assert.equal(intents.quote('1', 'a'), `https://x.com/intent/post?url=${encodeURIComponent(tweetUrl('1', 'a'))}`);
  assert.match(intents.post('Código ENG-1'), /text=C%C3%B3digo%20ENG-1$/);
});

test('el analizador de calidad separa comentarios buenos de spam', () => {
  const tweet = 'Lanzamos el nuevo cohete Starship desde Starbase esta semana';
  const low = ['🔥🔥🔥', 'gm', 'Buen post', 'nice post bro', 'wow wow wow wow', 'SIIIIIIII VAMOS', 'follow back bro check my bio', '', '   '];
  for (const t of low) assert.ok(analyzeReply(t, { tweetText: tweet }).score < 35, `debería ser bajo: "${t}"`);
  const good = [
    'Qué ganas de ver el Starship despegar desde Starbase, será histórico',
    'Totalmente de acuerdo, la misión va a cambiar la exploración espacial para siempre',
    '@marca Me encanta esta misión, ¡vamos Starship!',
    'Qué buena noticia para la ciencia y para todos los que seguimos el programa',
  ];
  for (const t of good) assert.ok(analyzeReply(t, { tweetText: tweet }).score >= 50, `debería ser bueno: "${t}"`);
  const r = analyzeReply('El nuevo cohete Starship de Starbase promete mucho', { tweetText: tweet });
  assert.ok(r.stats.relevance >= 2, 'detecta la relación con el post');
  assert.equal(analyzeReply('🔥').grade.key, 'spam');
});

test('similitud y detección de copias', () => {
  assert.equal(similarity('Hola mundo', 'hola   MUNDO!!'), 1);
  assert.ok(similarity('Me encanta esta misión espacial', 'Odio los lunes por la mañana') < 0.2);
  const cands = [{ userId: 'a', text: 'Qué ganas de ver el despegue del cohete esta semana' }];
  assert.equal(findDuplicate('Que ganas de ver el despegue del cohete esta semana!!', cands, 0.8).userId, 'a');
  assert.equal(findDuplicate('Algo totalmente distinto que no se parece en nada', cands, 0.8), null);
  assert.equal(findDuplicate('gm', [{ text: 'gm' }], 0.8), null, 'los textos muy cortos no cuentan como copia');
});

test('confianza', () => {
  assert.equal(applyTrust(50, 'auto_verified'), 52);
  assert.equal(applyTrust(99, 'auto_verified'), 100);
  assert.equal(applyTrust(5, 'revoked'), 0);
  assert.equal(applyTrust(50, 'desconocido'), 50);
  assert.equal(trustLevel(90).key, 'elite');
  assert.equal(trustLevel(60).key, 'confiable');
  assert.equal(trustLevel(30).key, 'normal');
  assert.equal(trustLevel(10).key, 'riesgo');
});

test('ajustes: se validan y se ignoran los valores incorrectos', () => {
  const base = withDefaults({});
  assert.deepEqual(base, withDefaults(DEFAULT_SETTINGS));
  const { settings, errors } = applySettingsPatch(base, {
    tasksChannelId: '123456789012345678',
    logChannelId: 'no-es-id',
    defaultActions: ['like', 'hack', 'reply'],
    defaultDurationMinutes: 99999999,
    points: { like: 5, repost: -3, reply: 'x' },
    verification: { proofMode: 'screenshot', minReplyQuality: 150, duplicateThreshold: 0.1, requireLink: 'false', maxAttempts: 'x' },
    reminders: { mode: 'sms', minutesBefore: 30 },
    embedColor: 'red',
  });
  assert.equal(settings.tasksChannelId, '123456789012345678');
  assert.equal(settings.logChannelId, null, 'el ID inválido no se guarda');
  assert.deepEqual(settings.defaultActions, ['like', 'reply']);
  assert.equal(settings.defaultDurationMinutes, 43200);
  assert.equal(settings.points.like, 5);
  assert.equal(settings.points.repost, 0);
  assert.equal(settings.points.reply, base.points.reply);
  assert.equal(settings.verification.proofMode, 'screenshot');
  assert.equal(settings.verification.minReplyQuality, 100);
  assert.equal(settings.verification.duplicateThreshold, 0.5);
  assert.equal(settings.verification.requireLink, false);
  assert.equal(settings.reminders.mode, 'channel');
  assert.equal(settings.reminders.minutesBefore, 30);
  assert.equal(settings.embedColor, base.embedColor);
  for (const k of ['logChannelId', 'points.reply', 'verification.maxAttempts', 'reminders.mode', 'embedColor']) {
    assert.ok(errors.some((e) => e.startsWith(k)), `debería informar del error en ${k}`);
  }
  assert.ok(applySettingsPatch(base, { defaultActions: [] }).errors.length === 1);
});
