'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { openDatabase } = require('../src/db/database');
const { Engine } = require('../src/core/engine');
const { XService } = require('../src/twitter/service');
const { MockX } = require('../src/twitter/providers/mock');
const { Simulator } = require('../src/sim/simulator');
const { silentLogger, tmpDir, GOOD } = require('./helpers');

/** Arranca el motor + el Discord simulado (sin panel web). */
function boot() {
  const dir = tmpDir();
  const log = silentLogger();
  const db = openDatabase(':memory:');
  const mock = new MockX();
  const x = new XService({ providers: [mock.provider], logger: log });
  const engine = new Engine({ db, x, log, dataDir: dir });
  const config = { web: { enabled: true, publicUrl: 'http://localhost:3000' }, discord: { ownerIds: [] } };
  const sim = new Simulator({ engine, mock, config, log });
  sim.attach();
  sim.seed();
  const U = sim.ids.users;
  const cleanup = () => {
    engine.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { engine, sim, mock, U, ids: sim.ids, cleanup };
}

const msgs = (sim, channelId, userId = null) => (sim.gateway.messages.get(channelId) || []).filter((m) => !m.ephemeralFor || m.ephemeralFor === userId);
const last = (sim, channelId, userId) => msgs(sim, channelId, userId).at(-1);
const text = (m) => JSON.stringify([m?.content, m?.embeds]);
const findButton = (m, pred) => m?.components?.flatMap((r) => r.components).find(pred);

async function ok(p) {
  const r = await p;
  assert.ok(r.ok, `la interacción falló: ${r.error || JSON.stringify(r.log)}`);
  return r;
}

async function click(sim, userId, message, labelOrId) {
  const b = findButton(message, (x) => x.label === labelOrId || x.custom_id === labelOrId);
  assert.ok(b, `no existe el botón ${labelOrId}`);
  return ok(sim.button({ userId, messageId: message.id, customId: b.custom_id }));
}

test('flujo completo del bot en Discord (simulado)', async (t) => {
  const { engine, sim, mock, U, ids, cleanup } = boot();
  t.after(cleanup);
  const staff = U['ana.staff'];
  const { tareas, logs, general } = ids;

  // ── Ayuda ───────────────────────────────────────────
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'ayuda' }));
  assert.match(text(last(sim, general, U.lucia)), /Ayuda del bot/);
  assert.doesNotMatch(text(last(sim, general, U.lucia)), /🛡️ Staff/, 'un miembro no ve los comandos de staff');
  await ok(sim.command({ userId: staff, channelId: general, name: 'ayuda' }));
  assert.match(text(last(sim, general, staff)), /Staff/);

  // ── Permisos: un miembro no puede crear tareas ───────
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'tarea', subcommand: 'crear', options: { enlace: sim.brandPosts[0].url } }));
  assert.match(text(last(sim, general, U.lucia)), /sólo para el staff/);

  // ── El staff crea una tarea ─────────────────────────
  await ok(sim.command({ userId: staff, channelId: general, name: 'tarea', subcommand: 'crear', options: { enlace: sim.brandPosts[0].url, duracion: '2h', nota: 'Comentad algo bonito' } }));
  assert.match(text(last(sim, general, staff)), /Tarea #1 publicada/);
  const taskMsg = msgs(sim, tareas).find((m) => /Tarea #1/.test(text(m)));
  assert.ok(taskMsg, 'la tarea se publicó en #tareas-x');
  const linkLabels = taskMsg.components[0].components.map((b) => b.label);
  assert.deepEqual(linkLabels, ['Like', 'Repostear', 'Comentar', 'Abrir post']);
  assert.ok(taskMsg.components[0].components.every((b) => b.style === 5 && b.url.startsWith('https://x.com/')));
  const task = engine.store.getTask(1);

  // ── Lucía pulsa "Ya lo hice" sin vincular → se le pide vincular ──
  await click(sim, U.lucia, taskMsg, 'Ya lo hice');
  const need = last(sim, tareas, U.lucia);
  assert.match(text(need), /Primero vincula tu cuenta/);
  await click(sim, U.lucia, need, 'Vincular mi cuenta');
  assert.equal(sim.pendingModals.get(U.lucia).modal.custom_id, 'eng:m:linkstart');
  await ok(sim.modal({ userId: U.lucia, fields: { handle: '@lucia_x' } }));
  const linkMsg = last(sim, tareas, U.lucia);
  const code = text(linkMsg).match(/ENG-[A-Z0-9]{6}/)[0];
  // Intenta verificar sin poner el código → error claro
  await click(sim, U.lucia, linkMsg, 'Verificar biografía');
  assert.match(text(last(sim, tareas, U.lucia)), /No encontramos el código/);
  sim.xAction({ userId: U.lucia, type: 'bio', text: `Hola ${code}` });
  await new Promise((r) => setTimeout(r, 5100)); // enfriamiento anti-spam de 5 s
  await click(sim, U.lucia, linkMsg, 'Verificar biografía');
  assert.match(text(last(sim, tareas, U.lucia)), /Cuenta de X vinculada/);
  assert.equal(engine.store.getLink(U.lucia).verified, true);

  // ── Lucía hace las acciones en X y verifica ─────────
  sim.xAction({ userId: U.lucia, type: 'like', tweetId: task.tweetId });
  sim.xAction({ userId: U.lucia, type: 'repost', tweetId: task.tweetId });
  const rep = sim.xAction({ userId: U.lucia, type: 'reply', tweetId: task.tweetId, text: GOOD[0] });
  await click(sim, U.lucia, taskMsg, 'Ya lo hice');
  const modal = sim.pendingModals.get(U.lucia).modal;
  assert.equal(modal.components[0].component.custom_id, 'reply');
  await ok(sim.modal({ userId: U.lucia, fields: { reply: rep.url } }));
  const done = last(sim, tareas, U.lucia);
  assert.match(text(done), /Tarea completada/);
  assert.match(text(done), /visto en tu perfil|Repost encontrado/);

  // ── Mi progreso y Quién falta ───────────────────────
  await click(sim, U.lucia, taskMsg, 'Mi progreso');
  assert.match(text(last(sim, tareas, U.lucia)), /3\/3/);
  await new Promise((r) => setTimeout(r, 50));
  await click(sim, U.mateo, taskMsg, 'Quién falta');
  const status = last(sim, tareas, U.mateo);
  assert.match(text(status), /Completaron \(1\)/);
  assert.match(text(status), /No participaron \(8\)/);

  // ── Mateo: comentario de baja calidad → rechazado, con botón para reintentar ──
  engine.links.adminLink({ userId: U.mateo, handleInput: 'mateo_x', guildId: sim.guildId });
  const bad = sim.xAction({ userId: U.mateo, type: 'reply', tweetId: task.tweetId, text: 'gm 🔥' });
  await click(sim, U.mateo, taskMsg, 'Ya lo hice');
  await ok(sim.modal({ userId: U.mateo, fields: { reply: bad.url } }));
  const rejected = last(sim, tareas, U.mateo);
  assert.match(text(rejected), /calidad de \d+\/100/);
  assert.ok(findButton(rejected, (b) => b.label === 'Reintentar'));

  // ── Sofía: /verificar con el enlace directamente (sin formulario) ──
  engine.links.adminLink({ userId: U.sofia, handleInput: 'sofia_x', guildId: sim.guildId });
  const rs = sim.xAction({ userId: U.sofia, type: 'reply', tweetId: task.tweetId, text: GOOD[1] });
  await ok(sim.command({ userId: U.sofia, channelId: tareas, name: 'verificar', options: { comentario: rs.url } }));
  assert.match(text(last(sim, tareas, U.sofia)), /Tarea completada/);

  // ── Diego: sube una captura → revisión en #staff-logs → aprobación ──
  engine.links.adminLink({ userId: U.diego, handleInput: 'diego_x', guildId: sim.guildId });
  await ok(sim.command({ userId: U.diego, channelId: tareas, name: 'prueba', options: { tarea: '1', accion: 'like' }, attachment: { sample: true } }));
  assert.match(text(last(sim, tareas, U.diego)), /Captura recibida/);
  await new Promise((r) => setTimeout(r, 30));
  const review = last(sim, logs, staff);
  assert.match(text(review), /Revisión pendiente/);
  await ok(sim.button({ userId: U.hugo, messageId: review.id, customId: findButton(review, (b) => b.label === 'Aprobar').custom_id }));
  assert.match(text(last(sim, logs, U.hugo)), /sólo para el staff/, 'un miembro no puede aprobar');
  await click(sim, staff, review, 'Aprobar');
  assert.match(text(sim.gateway.findMessage(review.id)), /Aprobado/);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(text(sim.gateway.dms.get(U.diego).at(-1)), /fue aprobado/);

  // Otra captura (repost) que el staff rechaza con motivo
  await new Promise((r) => setTimeout(r, 5100));
  await ok(sim.command({ userId: U.diego, channelId: tareas, name: 'prueba', options: { tarea: '1', accion: 'repost' }, attachment: { sample: true } }));
  await new Promise((r) => setTimeout(r, 30));
  const review2 = last(sim, logs, staff);
  await click(sim, staff, review2, 'Rechazar');
  await ok(sim.modal({ userId: staff, fields: { reason: 'No se ve el repost' } }));
  assert.match(text(sim.gateway.findMessage(review2.id)), /Rechazado[\s\S]*No se ve el repost/);

  // ── Perfil, ranking, tareas, autocompletado ─────────
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'perfil' }));
  assert.match(text(last(sim, general, U.lucia)), /@lucia_x/);
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'perfil', options: { miembro: U.sofia } }));
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'ranking', options: { periodo: 'semana' } }));
  assert.match(text(last(sim, general, U.lucia)), /Ranking/);
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'tareas' }));
  assert.match(text(last(sim, general, U.lucia)), /✅ \*\*\[#1\]/, 'marca las tareas ya completadas');
  const ac = await ok(sim.autocomplete({ userId: U.lucia, name: 'verificar', focused: { name: 'tarea', value: '' } }));
  assert.equal(ac.choices[0].value, 1);

  // ── Configuración (sólo administradores) ────────────
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'config', subcommand: 'ver' }));
  assert.match(text(last(sim, general, U.lucia)), /Gestionar servidor/);
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'verificacion', options: { modo: 'screenshot' } }));
  assert.match(text(last(sim, general, staff)), /Captura obligatoria/);
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'puntos', options: { like: '5', bonus: '10' } }));
  assert.equal(engine.store.getSettings(sim.guildId).points.like, 5);
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'duracion', options: { tiempo: '45m' } }));
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'recordatorios', options: { activar: 'true', minutos: '10', modo: 'both' } }));
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'calidad', options: { minimo: '40' } }));
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'rol-mencion', options: {} }));
  await ok(sim.command({ userId: staff, channelId: general, name: 'config', subcommand: 'ver' }));
  assert.match(text(last(sim, general, staff)), /45 min/);

  // ── Gestión de miembros ─────────────────────────────
  await ok(sim.command({ userId: staff, channelId: general, name: 'miembro', subcommand: 'puntos', options: { usuario: U.hugo, cantidad: '25', motivo: 'Sorteo' } }));
  assert.match(text(last(sim, general, staff)), /25/);
  await ok(sim.command({ userId: staff, channelId: general, name: 'miembro', subcommand: 'bloquear', options: { usuario: U.hugo } }));
  assert.equal(engine.store.getMember(sim.guildId, U.hugo).blacklisted, true);
  await ok(sim.command({ userId: staff, channelId: general, name: 'miembro', subcommand: 'desbloquear', options: { usuario: U.hugo } }));
  await ok(sim.command({ userId: staff, channelId: general, name: 'miembro', subcommand: 'vincular', options: { usuario: U.hugo, cuenta: 'hugo_x' } }));
  assert.equal(engine.store.getLink(U.hugo).handle, 'hugo_x');
  await ok(sim.command({ userId: staff, channelId: general, name: 'miembro', subcommand: 'desvincular', options: { usuario: U.hugo } }));
  assert.equal(engine.store.getLink(U.hugo), null);

  // ── Gestión de la tarea ─────────────────────────────
  await ok(sim.command({ userId: staff, channelId: general, name: 'tarea', subcommand: 'estado', options: { tarea: '1' } }));
  assert.match(text(last(sim, general, staff)), /quién hizo y quién no/);
  await ok(sim.command({ userId: staff, channelId: general, name: 'tarea', subcommand: 'extender', options: { tarea: '1', tiempo: '30m' } }));
  await ok(sim.command({ userId: staff, channelId: general, name: 'tarea', subcommand: 'recordar', options: { tarea: '1' } }));
  assert.match(text(last(sim, general, staff)), /Recordatorio enviado/);
  assert.ok(msgs(sim, tareas).some((m) => /Recordatorio/.test(m.content)), 'el recordatorio menciona a quien falta');
  assert.ok((sim.gateway.dms.get(U.camila) || []).some((m) => /Te falta completar/.test(text(m))), 'y le llega por MD (modo "ambos")');

  // El mensaje de la tarea se actualiza con el progreso
  await engine.tasks.flushDirty();
  assert.match(text(sim.gateway.findMessage(taskMsg.id)), /2\/9/);

  await ok(sim.command({ userId: staff, channelId: general, name: 'tarea', subcommand: 'cerrar', options: { tarea: '1' } }));
  assert.match(text(last(sim, general, staff)), /Tarea #1 cerrada/);
  const report = msgs(sim, tareas).find((m) => /Resultado final/.test(text(m)));
  assert.ok(report, 'se publicó el informe final');
  assert.match(text(report), /No participaron \(\d+\)/);
  const closedMsg = sim.gateway.findMessage(taskMsg.id);
  assert.ok(findButton(closedMsg, (b) => b.label === 'Ver resultados'));
  assert.ok(!findButton(closedMsg, (b) => b.label === 'Ya lo hice'), 'ya no se puede verificar');
  await ok(sim.command({ userId: U.mateo, channelId: tareas, name: 'verificar', options: { tarea: '1' } }));
  assert.match(text(last(sim, tareas, U.mateo)), /ya terminó/);

  // ── Desvincular ─────────────────────────────────────
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'desvincular' }));
  assert.match(text(last(sim, general, U.lucia)), /se desvinculó/);
  await ok(sim.command({ userId: U.lucia, channelId: general, name: 'desvincular' }));
  assert.match(text(last(sim, general, U.lucia)), /No tenías/);
});

test('/tarea crear con cita y rol a mencionar, y verificación de la cita', async (t) => {
  const { engine, sim, U, ids, cleanup } = boot();
  t.after(cleanup);
  const staff = U['ana.staff'];
  await ok(
    sim.command({
      userId: staff,
      channelId: ids.general,
      name: 'tarea',
      subcommand: 'crear',
      options: { enlace: sim.brandPosts[1].url, like: 'false', repost: 'false', comentario: 'false', cita: 'true', mencionar: ids.avisosRole, canal: ids.general, participantes: ids.raidersRole },
    }),
  );
  const taskMsg = msgs(sim, ids.general).find((m) => /Tarea #1/.test(text(m)));
  assert.match(taskMsg.content, new RegExp(`<@&${ids.avisosRole}>`));
  const task = engine.store.getTask(1);
  assert.deepEqual(task.actions, ['quote']);
  engine.links.adminLink({ userId: U.leo, handleInput: 'leo_x', guildId: sim.guildId });
  const q = sim.xAction({ userId: U.leo, type: 'quote', tweetId: task.tweetId, text: 'Me apunto al torneo del sábado a las 20:00, ¡a por el top 3 de la comunidad!' });
  await click(sim, U.leo, taskMsg, 'Ya lo hice');
  assert.equal(sim.pendingModals.get(U.leo).modal.components[0].component.custom_id, 'quote');
  await ok(sim.modal({ userId: U.leo, fields: { quote: q.url } }));
  assert.match(text(last(sim, ids.general, U.leo)), /Tarea completada/);
  // Todas las acciones en false → error claro
  await ok(sim.command({ userId: staff, channelId: ids.general, name: 'tarea', subcommand: 'crear', options: { enlace: sim.brandPosts[2].url, like: 'false' } }));
  assert.match(text(last(sim, ids.general, staff)), /al menos una acción/);
});

test('las interacciones rechazan usos inválidos igual que Discord', async (t) => {
  const { sim, U, ids, cleanup } = boot();
  t.after(cleanup);
  const r = await sim.modal({ userId: U.lucia, fields: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /No hay ningún formulario abierto/);
  const r2 = await sim.button({ userId: U.lucia, messageId: '1', customId: 'x' });
  assert.equal(r2.ok, false);
  // Formulario con campo obligatorio vacío
  await ok(sim.command({ userId: U.lucia, channelId: ids.general, name: 'tareas' }));
  await ok(sim.command({ userId: U.lucia, channelId: ids.general, name: 'verificar' }));
  assert.match(text(last(sim, ids.general, U.lucia)), /No hay tareas activas/);
});
