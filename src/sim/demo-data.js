'use strict';

const { sampleProofPng } = require('./png');

const GOOD_REPLIES = [
  'El modo oscuro era lo que más esperaba, por fin puedo usar la app de noche sin quemarme los ojos',
  'Un 40% más rápida se nota muchísimo, la sincronización en la nube me va a salvar la vida en el trabajo',
  'Me encantaría ver widgets para el escritorio en la próxima actualización, ¡gran trabajo equipo!',
  'Probé la versión 2.0 esta mañana y la sincronización funciona perfecta entre el móvil y el portátil',
  'Qué buena actualización. Para la próxima pediría exportar los datos a Excel directamente',
  'Llevo años usando la app y esta es la mejor versión hasta ahora, sobre todo por la velocidad',
];

const TOURNAMENT_REPLIES = [
  'Me apunto al torneo del sábado con mi equipo, ¡a por el top 3 de la comunidad!',
  'Qué ganas de jugar el torneo comunitario, las 20:00 me viene perfecto para conectarme',
  'Genial que haya sorteo para todos los participantes, así nadie se queda sin premio',
  'Confirmo asistencia al torneo del sábado, llevo toda la semana practicando',
  'Estas actividades hacen que la comunidad sea increíble, allí estaré el sábado a las 20:00',
];

/**
 * Crea datos de ejemplo pasando por el código real (crear tareas, verificar, cerrar…),
 * para que el panel y el simulador tengan contenido desde el primer momento.
 */
async function seedDemoData({ engine, sim, log }) {
  const { store, tasks, verification, links } = engine;
  const g = sim.guildId;
  const U = sim.ids.users;
  const mock = sim.mock;
  const user = (username) => {
    const u = sim.gateway.users.get(U[username]);
    return { id: u.id, username: u.username, displayName: u.globalName, avatar: u.avatar };
  };
  const staff = { id: U['ana.staff'], name: 'ana.staff' };

  // Cuentas de X vinculadas (menos Leo, para mostrar el flujo de vinculación en el simulador).
  for (const name of ['ana.staff', 'lucia', 'mateo', 'sofia', 'diego', 'valen', 'hugo', 'camila']) {
    const u = user(name);
    store.touchMember(g, u);
    const handle = sim.handleOf(u.id);
    const { code } = links.start(u, g, handle);
    mock.setBio(handle, `Hola 👋 ${code}`);
    await links.verifyBio(u);
    mock.setBio(handle, `Fan de la tecnología · ${u.displayName}`);
  }
  store.touchMember(g, user('leo'));

  // ── Tarea 1: el torneo (ya cerrada, con informe) ────────────────
  const [launch, tournament] = sim.brandPosts;
  const t1 = await tasks.create({ guildId: g, tweetUrl: tournament.url, actions: ['like', 'repost', 'reply'], duration: '2h', createdBy: staff });
  const doers1 = ['lucia', 'mateo', 'sofia', 'diego', 'valen'];
  for (const [i, name] of doers1.entries()) {
    const u = user(name);
    const handle = sim.handleOf(u.id);
    const reply = mock.addTweet({ handle, text: `@marca_demo ${TOURNAMENT_REPLIES[i]}`, replyTo: t1.tweetId });
    mock.like(handle, t1.tweetId);
    if (i % 2 === 0) mock.repost(handle, t1.tweetId);
    await verification.verify({ task: t1, user: u, inputs: { reply: reply.url } });
  }
  // Hugo sólo da like y comenta algo genérico (se rechaza por calidad).
  {
    const u = user('hugo');
    const reply = mock.addTweet({ handle: sim.handleOf(u.id), text: '@marca_demo top 🔥🔥', replyTo: t1.tweetId });
    await verification.verify({ task: t1, user: u, inputs: { reply: reply.url } });
  }
  engine.db.run('UPDATE tasks SET created_at = created_at - ?, ends_at = ends_at - ? WHERE id = ?', 26 * 3600_000, 26 * 3600_000, t1.id);
  await tasks.close(g, t1.id, { actor: { id: null, name: 'Automático' } });

  // ── Tarea 2: lanzamiento 2.0 (activa, con actividad a medias) ──
  const t2 = await tasks.create({
    guildId: g,
    tweetUrl: launch.url,
    actions: ['like', 'repost', 'reply'],
    duration: '3h',
    note: 'Comentad qué os gustaría ver en la próxima versión 🙌',
    createdBy: staff,
  });
  for (const [i, name] of ['lucia', 'sofia', 'camila'].entries()) {
    const u = user(name);
    const handle = sim.handleOf(u.id);
    const reply = mock.addTweet({ handle, text: `@marca_demo ${GOOD_REPLIES[i]}`, replyTo: t2.tweetId });
    mock.like(handle, t2.tweetId);
    mock.repost(handle, t2.tweetId);
    await verification.verify({ task: t2, user: u, inputs: { reply: reply.url } });
  }
  // Mateo comenta algo copiado de Lucía (lo detecta el antiplagio).
  {
    const u = user('mateo');
    const reply = mock.addTweet({ handle: sim.handleOf(u.id), text: `@marca_demo ${GOOD_REPLIES[0]}!!`, replyTo: t2.tweetId });
    await verification.verify({ task: t2, user: u, inputs: { reply: reply.url } });
  }
  // Diego sube una captura del like en vez de declararlo (queda en revisión).
  await verification.submitProof({ task: t2, user: user('diego'), action: 'like', attachment: { contentType: 'image/png', buffer: sampleProofPng(), name: 'captura.png' } });
  engine.db.run('UPDATE tasks SET created_at = created_at - ?, ends_at = ends_at - ? WHERE id = ?', 50 * 60_000, 50 * 60_000, t2.id);

  await tasks.flushDirty();
  log.info(`Datos de demostración creados: tareas #${t1.id} (cerrada) y #${t2.id} (activa).`);
  return { t1, t2 };
}

module.exports = { seedDemoData };
