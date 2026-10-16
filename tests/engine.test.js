'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { G, CH, ROLE, createEngine, linkedUser, reply, GOOD, tmpDir, uid } = require('./helpers');
const { sampleProofPng } = require('../src/sim/png');

const byAction = (results) => Object.fromEntries(results.map((r) => [r.action, r]));
const points = (ctx, userId) => ctx.engine.store.getMember(G, userId).points;

test('crear tarea: validaciones y publicación', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const { tasks } = ctx.engine;
  await assert.rejects(tasks.create({ guildId: G, tweetUrl: 'hola' }), /no es un post de X válido/);
  await assert.rejects(tasks.create({ guildId: G, tweetUrl: 'https://x.com/a/status/123', duration: 'mucho' }), /Duración no válida/);
  // Un post que ninguna fuente conoce (el mock no lo tiene y no hay fuentes reales en las pruebas)
  await assert.rejects(tasks.create({ guildId: G, tweetUrl: 'https://x.com/a/status/123' }), /X no respondió|No encontramos/);

  const task = await tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like', 'reply', 'nada'], duration: '2h', pointsMultiplier: 2, note: ' nota ' });
  assert.deepEqual(task.actions, ['like', 'reply']);
  assert.equal(task.points.like, 2);
  assert.equal(task.note, 'nota');
  assert.equal(task.endsAt - task.createdAt, 120 * 60_000);
  assert.ok(task.messageId, 'se guardó el mensaje publicado');
  assert.equal(ctx.publisher.of('postTask').length, 1);
  await assert.rejects(tasks.create({ guildId: G, tweetUrl: ctx.brand.url }), /Ya hay una tarea activa/);

  // Sin canal configurado
  ctx.engine.updateSettings(G, { tasksChannelId: null });
  const other = ctx.mock.addTweet({ handle: 'marca', text: 'otro post' });
  await assert.rejects(tasks.create({ guildId: G, tweetUrl: other.url }), /No hay canal de tareas/);

  // Si Discord falla al publicar, la tarea no se queda a medias
  ctx.publisher.postTask = async () => {
    throw new Error('Missing Access');
  };
  await assert.rejects(tasks.create({ guildId: G, tweetUrl: other.url, channelId: CH }), /No pude publicar la tarea/);
  assert.equal(ctx.engine.store.listTasks(G).total, 1);
});

test('vinculación de cuenta de X por biografía y por post', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const { links } = ctx.engine;
  const u = { id: uid(), username: 'ana' };
  ctx.mock.addProfile({ handle: 'ana_x' });
  assert.throws(() => links.start(u, G, 'no valido!'), /no es válido/);
  await assert.rejects(links.verifyBio(u), /No tienes ninguna vinculación pendiente/);
  const { code } = links.start(u, G, '@ana_x');
  assert.match(code, /^ENG-[A-Z2-9]{6}$/);
  await assert.rejects(links.verifyBio(u), /No encontramos el código/);
  ctx.mock.setBio('ana_x', `mi bio ${code.toLowerCase()}`);
  const link = await links.verifyBio(u);
  assert.equal(link.verified, true);
  assert.equal(link.method, 'bio');

  // Otra persona no puede quedarse con la misma cuenta verificada
  const intruso = { id: uid(), username: 'intruso' };
  assert.throws(() => links.start(intruso, G, 'ana_x'), /ya está vinculada/);

  // Verificación por post
  const b = { id: uid(), username: 'beto' };
  ctx.mock.addProfile({ handle: 'beto_x' });
  const s = links.start(b, G, 'beto_x');
  const wrong = ctx.mock.addTweet({ handle: 'ana_x', text: s.code });
  await assert.rejects(links.verifyTweet(b, wrong.url), /es de \*\*@ana_x\*\*/);
  const noCode = ctx.mock.addTweet({ handle: 'beto_x', text: 'hola' });
  await assert.rejects(links.verifyTweet(b, noCode.url), /no contiene el código/);
  const good = ctx.mock.addTweet({ handle: 'beto_x', text: `Verificando ${s.code}` });
  assert.equal((await links.verifyTweet(b, good.url)).method, 'tweet');

  // Código caducado
  const c = { id: uid(), username: 'caro' };
  ctx.mock.addProfile({ handle: 'caro_x' });
  links.start(c, G, 'caro_x');
  ctx.db.run('UPDATE link_requests SET expires_at = 0 WHERE user_id = ?', c.id);
  await assert.rejects(links.verifyBio(c), /caducó/);

  // Cuenta inexistente y fuente caída
  const d = { id: uid(), username: 'dani' };
  links.start(d, G, 'dani_x');
  await assert.rejects(links.verifyBio(d), /X no respondió|No encontramos la cuenta/);
  ctx.mock.addProfile({ handle: 'dani_x' });
  ctx.mock.failNext = 'UNAVAILABLE';
  await assert.rejects(links.verifyBio(d), /X no respondió/);

  assert.equal(links.unlink(u.id, { guildId: G }), true);
  assert.equal(links.get(u.id), null);
  // Vinculación manual del staff quita la verificación ajena
  const manual = links.adminLink({ userId: intruso.id, handleInput: 'beto_x', guildId: G });
  assert.equal(manual.verified, true);
  assert.equal(links.get(b.id), null, 'el anterior dueño pierde la cuenta');
});

test('verificación completa: comentario comprobado, repost en el perfil, like declarado, puntos y bonus', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url });
  const ana = await linkedUser(ctx, 'ana');
  const r1 = reply(ctx, ana, task, GOOD[0]);
  ctx.mock.repost(ana.handle, task.tweetId);
  const res = await ctx.engine.verification.verify({ task, user: ana, inputs: { reply: r1.url } });
  const a = byAction(res.results);
  assert.equal(a.like.state, 'verified');
  assert.equal(a.repost.method, 'timeline');
  assert.equal(a.reply.method, 'auto');
  assert.ok(a.reply.quality >= 50);
  assert.equal(res.completedNow, true);
  // 1 + 2 + 3 + bonus 2
  assert.equal(points(ctx, ana.id), 8);
  assert.equal(ctx.engine.store.getMember(G, ana.id).completed, 1);
  assert.ok(ctx.engine.store.getMember(G, ana.id).trust > 50, 'sube la confianza');
  // Repetir no suma dos veces
  const again = await ctx.engine.verification.verify({ task, user: ana, inputs: {} });
  assert.ok(again.results.every((r) => r.state === 'already'));
  assert.equal(points(ctx, ana.id), 8);
  assert.ok(ctx.engine.tasks.dirty.has(task.id), 'el mensaje de la tarea se actualizará');
});

test('verificación: rechazos inteligentes del comentario', async (t) => {
  const ctx = createEngine({ settings: { verification: { maxAttempts: 20 } } });
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['reply'] });
  const ana = await linkedUser(ctx, 'ana');
  const beto = await linkedUser(ctx, 'beto');
  const v = (user, url) => ctx.engine.verification.verify({ task, user, inputs: { reply: url } }).then((r) => byAction(r.results).reply);

  assert.equal((await ctx.engine.verification.verify({ task, user: ana, inputs: {} })).results[0].state, 'missing');
  assert.match((await v(ana, 'no es un enlace')).message, /no es un post de X válido/);
  assert.match((await v(ana, task.tweetUrl)).message, /enlace del post de la tarea/);
  const deBeto = reply(ctx, beto, task, GOOD[1]);
  assert.match((await v(ana, deBeto.url)).message, /es de @beto_x/);
  const suelto = ctx.mock.addTweet({ handle: ana.handle, text: GOOD[1] });
  assert.match((await v(ana, suelto.url)).message, /no es una respuesta/);
  const malo = reply(ctx, ana, task, 'gm 🔥');
  const rMalo = await v(ana, malo.url);
  assert.equal(rMalo.state, 'rejected');
  assert.match(rMalo.message, /calidad de \d+\/100/);
  assert.match((await v(ana, 'https://x.com/ana_x/status/999999999999999999')).message, /No encontramos|X no respondió/);

  // Fuente caída: no se gasta intento
  const bueno = reply(ctx, ana, task, GOOD[2]);
  ctx.mock.failNext = 'UNAVAILABLE';
  const caido = await v(ana, bueno.url);
  assert.equal(caido.state, 'error');
  const sub = ctx.engine.store.userSubmissions(task.id, ana.id)[0];
  const attempts = sub.attempts;
  assert.equal((await v(ana, bueno.url)).state, 'verified');
  assert.equal(ctx.engine.store.userSubmissions(task.id, ana.id)[0].attempts, attempts + 1);

  // Copia del comentario de otro miembro
  const copia = reply(ctx, beto, task, `${GOOD[2]}!!`);
  const rCopia = await v(beto, copia.url);
  assert.equal(rCopia.state, 'rejected');
  assert.match(rCopia.message, /casi igual al de otro miembro/);
  assert.ok(ctx.engine.store.getMember(G, beto.id).trust < 50, 'la copia baja la confianza');

  // Reusar el mismo post de otra persona: el autor no coincide
  assert.match((await v(beto, bueno.url)).message, /es de @ana_x/);
  assert.equal(ctx.engine.store.getMember(G, beto.id).rejected >= 2, true);
});

test('verificación: límite de intentos y cuenta privada', async (t) => {
  const ctx = createEngine({ settings: { verification: { maxAttempts: 2 } } });
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['reply'] });
  const ana = await linkedUser(ctx, 'ana');
  for (let i = 0; i < 2; i++) await ctx.engine.verification.verify({ task, user: ana, inputs: { reply: 'malo' } });
  const r = await ctx.engine.verification.verify({ task, user: ana, inputs: { reply: reply(ctx, ana, task, GOOD[0]).url } });
  assert.match(r.results[0].message, /Agotaste los 2 intentos/);
  // El staff puede corregirlo a mano
  const p = ctx.engine.verification.setManual(G, task.id, ana.id, 'reply', { done: true, reviewer: { name: 'staff' } });
  assert.equal(p.complete, true);

  const priv = await linkedUser(ctx, 'privada');
  ctx.mock.getProfileSync(priv.handle).protected = true;
  const rp = ctx.mock.addTweet({ handle: priv.handle, text: GOOD[1], replyTo: task.tweetId });
  const res = await ctx.engine.verification.verify({ task, user: priv, inputs: { reply: rp.url } });
  assert.match(res.results[0].message, /privada/);
});

test('acceso: sin vincular, sin verificar, bloqueado o tarea cerrada', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like'] });
  const v = (user) => ctx.engine.verification.verify({ task, user, inputs: {} });
  await assert.rejects(v({ id: uid(), username: 'x' }), /Primero vincula/);
  const sinVerificar = await linkedUser(ctx, 'sinver', { verify: false });
  ctx.engine.links.linkUnverified(sinVerificar, G, sinVerificar.handle);
  await assert.rejects(v(sinVerificar), /sin verificar/);
  ctx.engine.updateSettings(G, { verification: { requireVerifiedLink: false } });
  assert.equal((await v(sinVerificar)).completedNow, true);
  const malo = await linkedUser(ctx, 'bloqueado');
  ctx.engine.store.updateMember(G, malo.id, { blacklisted: true });
  await assert.rejects(v(malo), /No puedes participar/);
  await ctx.engine.tasks.close(G, task.id);
  await assert.rejects(v(await linkedUser(ctx, 'tarde')), /ya terminó/);
});

test('modo captura: espera la captura, revisión del staff y aprobación automática por confianza', async (t) => {
  const dir = tmpDir();
  const ctx = createEngine({ dataDir: dir, settings: { verification: { proofMode: 'screenshot' } } });
  t.after(() => {
    ctx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like'] });
  const ana = await linkedUser(ctx, 'ana');
  const r = await ctx.engine.verification.verify({ task, user: ana, inputs: {} });
  assert.equal(r.results[0].state, 'awaiting');
  assert.equal(r.progress.state, 'pending');

  await assert.rejects(
    ctx.engine.verification.submitProof({ task, user: ana, action: 'like', attachment: { contentType: 'text/plain', buffer: Buffer.from('hola') } }),
    /debe ser una imagen/,
  );
  await assert.rejects(
    ctx.engine.verification.submitProof({ task, user: ana, action: 'like', attachment: { contentType: 'image/png', buffer: Buffer.from('no soy png de verdad') } }),
    /no parece una imagen/,
  );
  await assert.rejects(ctx.engine.verification.submitProof({ task, user: ana, action: 'reply', attachment: { contentType: 'image/png', buffer: sampleProofPng() } }), /sólo sirven para like o repost/);
  const proof = await ctx.engine.verification.submitProof({ task, user: ana, action: 'like', attachment: { contentType: 'image/png', buffer: sampleProofPng() } });
  assert.equal(proof.autoApproved, false);
  assert.equal(proof.submission.status, 'pending');
  const file = ctx.engine.verification.proofPath(proof.submission.evidenceUrl);
  assert.ok(fs.existsSync(file), 'la captura se guarda en disco');
  assert.equal(ctx.engine.store.pendingReviews(G).length, 1);
  await new Promise((r2) => setImmediate(r2));
  assert.equal(ctx.publisher.of('reviewRequest').length, 1, 'se avisa al canal del staff');

  // Rechazo y luego aprobación
  ctx.engine.verification.review(G, proof.submission.id, { approve: false, reviewer: { name: 'staff' }, reason: 'no se ve' });
  assert.equal(points(ctx, ana.id), 0);
  const ok = ctx.engine.verification.review(G, proof.submission.id, { approve: true, reviewer: { name: 'staff' } });
  assert.equal(ok.progress.complete, true);
  assert.equal(points(ctx, ana.id), 1 + 2);
  assert.throws(() => ctx.engine.verification.review(G, proof.submission.id, { approve: true }), /Ya estaba aprobado/);
  await new Promise((r2) => setImmediate(r2));
  assert.equal(ctx.publisher.of('reviewDecided').length, 2, 'el miembro recibe el resultado');

  // Confianza alta → aprobada al momento
  const vip = await linkedUser(ctx, 'vip');
  ctx.engine.store.updateMember(G, vip.id, { trust: 95 });
  const rv = await ctx.engine.verification.verify({ task, user: vip, inputs: {} });
  assert.equal(rv.results[0].state, 'verified');
  assert.match(rv.results[0].message, /confianza/);
});

test('modo revisión: la declaración espera al staff', async (t) => {
  const ctx = createEngine({ settings: { verification: { proofMode: 'review', repostTimelineCheck: true } } });
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like', 'repost'] });
  const ana = await linkedUser(ctx, 'ana');
  ctx.mock.repost(ana.handle, task.tweetId);
  const r = byAction((await ctx.engine.verification.verify({ task, user: ana, inputs: {} })).results);
  assert.equal(r.like.state, 'pending');
  assert.equal(r.repost.state, 'verified', 'el repost encontrado en el perfil no necesita revisión');
  const again = byAction((await ctx.engine.verification.verify({ task, user: ana, inputs: {} })).results);
  assert.equal(again.like.state, 'pending');
  assert.equal(ctx.engine.store.pendingReviews(G).length, 1);
});

test('cierre: quién hizo y quién no, rachas, recomprobación y alertas antifraude', async (t) => {
  const ids = [];
  const ctx = createEngine({ roleMembers: ids });
  t.after(() => ctx.close());
  const [ana, beto, caro, dani] = [await linkedUser(ctx, 'ana'), await linkedUser(ctx, 'beto'), await linkedUser(ctx, 'caro'), await linkedUser(ctx, 'dani')];
  const eva = { id: uid(), username: 'eva' };
  ids.push(ana.id, beto.id, caro.id, eva.id); // dani no tiene el rol
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, roleId: ROLE });
  const v = ctx.engine.verification;
  // ana completa (repost real), beto completa y luego borra su comentario, caro sólo da like, dani (sin rol) completa
  const ra = reply(ctx, ana, task, GOOD[0]);
  ctx.mock.repost(ana.handle, task.tweetId);
  ctx.mock.like(ana.handle, task.tweetId);
  await v.verify({ task, user: ana, inputs: { reply: ra.url } });
  const rb = reply(ctx, beto, task, GOOD[1]);
  await v.verify({ task, user: beto, inputs: { reply: rb.url } });
  await v.verify({ task, user: caro, inputs: { reply: 'nada' } });
  const rd = reply(ctx, dani, task, GOOD[2]);
  await v.verify({ task, user: dani, inputs: { reply: rd.url } });
  // 3 declaran repost pero sólo hay 1 real
  ctx.mock.deleteTweet(rb.id);

  const view = await ctx.engine.tasks.view(ctx.engine.store.getTask(task.id));
  assert.equal(view.expectedCount, 4);
  assert.equal(view.completed, 3);

  const s = await ctx.engine.tasks.close(G, task.id);
  assert.deepEqual(s.completed.map((u) => u.id).sort(), [ana.id, dani.id].sort(), 'beto pierde la tarea al borrar el comentario');
  assert.deepEqual(s.partial.map((u) => u.id).sort(), [beto.id, caro.id].sort());
  assert.deepEqual(s.missing.map((u) => u.id), [eva.id]);
  assert.equal(s.expectedCount, 4);
  const closed = ctx.engine.store.getTask(task.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.report.revoked, 1);
  assert.equal(closed.report.expectedIds.length, 4);
  assert.equal(ctx.engine.store.getMember(G, ana.id).streak, 1);
  assert.equal(ctx.engine.store.getMember(G, eva.id).missed, 1);
  assert.equal(ctx.engine.store.getMember(G, beto.id).completed, 0, 'se descuenta la tarea completada');
  assert.equal(points(ctx, beto.id), 1 + 2, 'pierde los puntos del comentario y el bonus');
  assert.equal(ctx.publisher.of('sendReport').length, 1);
  assert.ok(ctx.publisher.of('updateTask').some((c) => c.status === 'closed'));
  await assert.rejects(ctx.engine.tasks.close(G, task.id), /ya está cerrada/);
  // Resumen en vivo de una tarea cerrada usa los esperados guardados
  const live = await ctx.engine.tasks.liveSummary(closed);
  assert.equal(live.expectedCount, 4);
});

test('antifraude por contadores públicos', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like'] });
  for (let i = 0; i < 8; i++) {
    const u = await linkedUser(ctx, `u${i}`);
    if (i < 2) ctx.mock.like(u.handle, task.tweetId);
    await ctx.engine.verification.verify({ task, user: u, inputs: {} });
  }
  const { flags } = await ctx.engine.tasks.refreshMetrics(ctx.engine.store.getTask(task.id));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].claimed, 8);
  assert.equal(flags[0].delta, 2);
  assert.ok(ctx.engine.store.listAudit(G, { type: 'fraud' }).length >= 1);
});

test('cancelar, extender, recordar y eliminar (con puntos)', async (t) => {
  const ids = [];
  const ctx = createEngine({ roleMembers: ids });
  t.after(() => ctx.close());
  const ana = await linkedUser(ctx, 'ana');
  const beto = await linkedUser(ctx, 'beto');
  ids.push(ana.id, beto.id);
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like'], roleId: ROLE, duration: '30m' });
  await ctx.engine.verification.verify({ task, user: ana, inputs: {} });
  const ext = await ctx.engine.tasks.extend(G, task.id, '1h');
  assert.equal(ext.endsAt, task.endsAt + 60 * 60_000);
  const rem = await ctx.engine.tasks.remind(G, task.id);
  assert.equal(rem.targets, 1);
  assert.deepEqual(ctx.publisher.of('sendReminder')[0].users, [beto.id]);
  await assert.rejects(ctx.engine.tasks.remind(G, task.id), /hace menos de 5 minutos/);

  assert.equal(points(ctx, ana.id), 3);
  await ctx.engine.tasks.remove(G, task.id);
  assert.equal(points(ctx, ana.id), 0, 'al eliminar se retiran los puntos');
  assert.equal(ctx.engine.store.getMember(G, ana.id).completed, 0);
  assert.equal(ctx.engine.store.getTask(task.id), null);
  assert.equal(ctx.engine.store.taskSubmissions(task.id).length, 0);

  const other = ctx.mock.addTweet({ handle: 'marca', text: 'otro' });
  const t2 = await ctx.engine.tasks.create({ guildId: G, tweetUrl: other.url });
  await ctx.engine.tasks.cancel(G, t2.id);
  assert.equal(ctx.engine.store.getTask(t2.id).status, 'cancelled');
  await assert.rejects(ctx.engine.tasks.cancel(G, t2.id), /no está activa/);
  await assert.rejects(ctx.engine.tasks.extend(G, t2.id, '1h'), /Sólo se pueden extender/);
});

test('planificador: recordatorio automático y cierre automático', async (t) => {
  const ctx = createEngine({ roleMembers: [] });
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, duration: '60m', roleId: ROLE });
  ctx.engine.scheduler.stopped = false;
  // 50 minutos después: toca el recordatorio (15 min antes)
  ctx.db.run('UPDATE tasks SET created_at = created_at - ?, ends_at = ends_at - ? WHERE id = ?', 50 * 60_000, 50 * 60_000, task.id);
  await ctx.engine.scheduler.tick();
  assert.ok(ctx.engine.store.getTask(task.id).remindedAt, 'se envió el recordatorio');
  await ctx.engine.scheduler.tick();
  assert.equal(ctx.publisher.of('sendReminder').length, 1, 'sólo una vez');
  // Ya terminó
  ctx.db.run('UPDATE tasks SET ends_at = ? WHERE id = ?', Date.now() - 1000, task.id);
  await ctx.engine.scheduler.tick();
  assert.equal(ctx.engine.store.getTask(task.id).status, 'closed');
  assert.equal(ctx.publisher.of('sendReport').length, 1);
  await ctx.engine.scheduler.flush();
  ctx.engine.scheduler.stop();
});

test('ranking, perfil y ajustes manuales de puntos', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['like'] });
  const a = await linkedUser(ctx, 'ana');
  const b = await linkedUser(ctx, 'beto');
  await ctx.engine.verification.verify({ task, user: a, inputs: {} });
  ctx.engine.store.addLedger({ guildId: G, userId: b.id, kind: 'manual', amount: 50, reason: 'premio' });
  const top = ctx.engine.store.leaderboard(G);
  assert.equal(top[0].user_id, b.id);
  assert.equal(ctx.engine.store.rankOf(G, a.id), 2);
  assert.equal(ctx.engine.store.rankOf(G, uid()), null);
  const list = ctx.engine.store.listMembers(G, { search: 'ana' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].xHandle, 'ana_x');
  assert.equal(ctx.engine.store.completedTaskIds(a.id, [task.id]).has(task.id), true);
});

test('los archivos de capturas quedan dentro de la carpeta de pruebas', () => {
  const { VerificationService } = require('../src/core/verification');
  const v = new VerificationService({ store: null, x: null, tasks: null, proofsDir: path.join(tmpDir(), 'p') });
  assert.equal(v.proofPath('proof:../../etc/passwd'), null);
  assert.equal(v.proofPath('http://x'), null);
  assert.ok(v.proofPath('proof:123-abc.png').endsWith('123-abc.png'));
});
