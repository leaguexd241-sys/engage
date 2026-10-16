'use strict';

/**
 * Prueba de resistencia y de fugas de memoria.
 * Ejecuta miles de interacciones reales (comandos, botones, formularios, verificaciones, cierres)
 * a través del mismo código que usa el bot en Discord, y mide la memoria tras cada ronda.
 *
 *   npm run soak            (usa node --expose-gc)
 *   npm run soak -- 40 120  (rondas, miembros)
 */
const { openDatabase } = require('../src/db/database');
const { Engine } = require('../src/core/engine');
const { XService } = require('../src/twitter/service');
const { MockX } = require('../src/twitter/providers/mock');
const { Simulator } = require('../src/sim/simulator');
const { Logger } = require('../src/logger');

const ROUNDS = Number(process.argv[2]) || 30;
const MEMBERS = Number(process.argv[3]) || 100;

const REPLIES = [
  'Qué ganas de ver esta novedad funcionando, la comunidad lo estaba pidiendo desde hace meses',
  'Gran anuncio, me encanta cómo está evolucionando el proyecto con cada actualización nueva',
  'Esto va a cambiar la forma en la que usamos la app todos los días, muy buen trabajo',
  'Me apunto sin dudarlo, espero que haya muchas más actividades como esta en el futuro',
];

function mb(n) {
  return (n / 1024 / 1024).toFixed(1);
}

async function main() {
  if (typeof global.gc !== 'function') {
    console.error('Ejecuta con: node --expose-gc scripts/soak.js (o npm run soak)');
    process.exit(1);
  }
  const log = new Logger({ level: 'silent' });
  const db = openDatabase(':memory:');
  const mock = new MockX();
  mock.maxTweets = 800; // el X simulado también tiene tope; así se alcanza pronto el régimen estable
  const x = new XService({ providers: [mock.provider], logger: log });
  const engine = new Engine({ db, x, log });
  const sim = new Simulator({ engine, mock, config: { web: { enabled: false }, discord: { ownerIds: [] } }, log });
  sim.attach();
  sim.seed();
  // Sin enfriamientos anti-spam para poder lanzar miles de interacciones seguidas.
  sim.handler.cooldown = { hit: () => 0 };
  const staff = sim.ids.users['ana.staff'];
  const g = sim.guildId;

  // Miembros extra con cuenta de X vinculada
  const users = [];
  for (let i = 0; i < MEMBERS; i++) {
    const u = sim.gateway.addMember(g, { username: `m${i}`, name: `Miembro ${i}`, roles: [sim.ids.raidersRole] });
    mock.addProfile({ handle: `m${i}_x` });
    engine.links.adminLink({ userId: u.id, handleInput: `m${i}_x`, guildId: g });
    users.push({ id: u.id, handle: `m${i}_x` });
  }

  let interactions = 0;
  let failures = 0;
  const run = async (p) => {
    interactions += 1;
    const r = await p;
    if (!r.ok) {
      failures += 1;
      if (failures < 5) console.error('Fallo:', r.error || JSON.stringify(r.log));
    }
    return r;
  };

  const samples = [];
  const t0 = Date.now();
  for (let round = 1; round <= ROUNDS; round++) {
    const post = mock.addTweet({ handle: 'marca_demo', text: `Anuncio número ${round}: nueva función para toda la comunidad, ¿qué os parece?` });
    await run(sim.command({ userId: staff, channelId: sim.ids.tareas, name: 'tarea', subcommand: 'crear', options: { enlace: post.url, duracion: '1h' } }));
    const task = engine.store.activeTasks(g)[0];
    const taskMsg = sim.gateway.messages.get(sim.ids.tareas).filter((m) => !m.ephemeralFor).at(-1);
    for (const [i, u] of users.entries()) {
      mock.like(u.handle, task.tweetId);
      if (i % 2 === 0) mock.repost(u.handle, task.tweetId);
      const text = i % 7 === 0 ? 'gm' : `${REPLIES[i % REPLIES.length]} (${round}-${i})`;
      const r = mock.addTweet({ handle: u.handle, text: `@marca_demo ${text}`, replyTo: task.tweetId });
      await run(sim.button({ userId: u.id, messageId: taskMsg.id, customId: `eng:verify:${task.id}` }));
      if (sim.pendingModals.has(u.id)) await run(sim.modal({ userId: u.id, fields: { reply: r.url } }));
      if (i % 5 === 0) await run(sim.button({ userId: u.id, messageId: taskMsg.id, customId: `eng:progress:${task.id}` }));
      if (i % 10 === 0) await run(sim.button({ userId: u.id, messageId: taskMsg.id, customId: `eng:status:${task.id}` }));
      if (i % 25 === 0) await run(sim.autocomplete({ userId: u.id, name: 'verificar', focused: { name: 'tarea', value: '' } }));
      sim.gateway.clearEphemerals(u.id);
    }
    await engine.tasks.flushDirty();
    await run(sim.command({ userId: staff, channelId: sim.ids.general, name: 'tarea', subcommand: 'cerrar', options: { tarea: String(task.id) } }));
    await run(sim.command({ userId: staff, channelId: sim.ids.general, name: 'ranking' }));
    sim.gateway.clearEphemerals(staff);
    x.prune();

    global.gc();
    await new Promise((r) => setTimeout(r, 20));
    global.gc();
    const mem = process.memoryUsage();
    samples.push({ round, heapMB: Number(mb(mem.heapUsed)), rssMB: Number(mb(mem.rss)) });
    if (round % 5 === 0 || round === 1) {
      console.log(`Ronda ${String(round).padStart(3)} · interacciones ${String(interactions).padStart(6)} · heap ${mb(mem.heapUsed)} MB · rss ${mb(mem.rss)} MB · caché X ${x.status().cacheSize} · candados ${engine.verification.lock.size}`);
    }
  }
  const secs = (Date.now() - t0) / 1000;

  // Comparamos la memoria después del calentamiento con la del final.
  const warm = samples[Math.min(Math.floor(samples.length / 3), samples.length - 1)];
  const end = samples.at(-1);
  const growth = end.heapMB - warm.heapMB;
  const perRound = growth / Math.max(1, end.round - warm.round);
  console.log('');
  console.log(`Interacciones: ${interactions} en ${secs.toFixed(1)} s (${Math.round(interactions / secs)}/s) · fallos: ${failures}`);
  console.log(`Heap tras calentamiento (ronda ${warm.round}): ${warm.heapMB} MB · final (ronda ${end.round}): ${end.heapMB} MB · variación ${growth.toFixed(1)} MB (${perRound.toFixed(3)} MB/ronda)`);
  const leak = perRound > 0.25;
  console.log(leak ? '❌ La memoria sigue creciendo: posible fuga.' : '✅ Memoria estable: sin fugas detectadas.');
  engine.stop();
  db.close();
  process.exit(leak || failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

