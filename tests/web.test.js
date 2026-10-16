'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { main } = require('../src/index');
const { tmpDir } = require('./helpers');

let app;
let base;
let cookie = '';
let gid;
let fakeDiscord;
const dir = tmpDir();

function req(path, { method = 'GET', body, headers = {}, raw = false, noCookie = false } = {}) {
  const h = { 'x-requested-with': 'engage-panel', ...headers };
  if (cookie && !noCookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }).then(async (r) => {
    if (raw) return r;
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* no es JSON */
    }
    return { status: r.status, json, text, headers: r.headers };
  });
}

test.before(async () => {
  // Discord falso para probar el inicio de sesión OAuth2
  fakeDiscord = http.createServer((q, s) => {
    s.setHeader('content-type', 'application/json');
    if (q.url === '/api/oauth2/token') {
      let body = '';
      q.on('data', (c) => (body += c));
      q.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('code') !== 'buen-codigo') return s.writeHead(400).end('{"error":"invalid_grant"}');
        return s.end(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }));
      });
      return;
    }
    if (q.url === '/api/users/@me') return s.end(JSON.stringify({ id: '777777777777777777', username: 'moderadora', global_name: 'Moderadora', avatar: null }));
    if (q.url === '/api/users/@me/guilds') {
      return s.end(JSON.stringify([{ id: app.sim.guildId, permissions: String(0x20) }, { id: '555555555555555555', permissions: '0', owner: false }]));
    }
    s.writeHead(404).end('{}');
  });
  await new Promise((r) => fakeDiscord.listen(0, '127.0.0.1', r));
  app = await main({
    demo: true,
    handleSignals: false,
    overrides: {
      dataDir: dir,
      port: 0,
      logLevel: 'silent',
      logToFile: false,
      clientId: '123456789012345678',
      clientSecret: 'secreto',
      discordApiBase: `http://127.0.0.1:${fakeDiscord.address().port}/api`,
    },
  });
  base = `http://127.0.0.1:${app.web.port}`;
  gid = app.sim.guildId;
});

test.after(async () => {
  await app?.stop();
  await new Promise((r) => fakeDiscord.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('salud, cabeceras de seguridad y archivos estáticos', async () => {
  const h = await req('/healthz');
  assert.equal(h.json.ok, true);
  const page = await req('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Engage/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal((await req('/js/main.js')).status, 200);
  assert.equal((await req('/api/no-existe')).status, 401, 'la API desconocida también exige sesión');
});

test('inicio de sesión con contraseña, CSRF y límite de intentos', async () => {
  let s = await req('/api/session');
  assert.equal(s.json.authenticated, false);
  assert.equal(s.json.oauthEnabled, true);
  assert.equal((await req('/api/guilds')).status, 401);
  // Sin la cabecera del panel → se bloquea (protección CSRF)
  const csrf = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"demo"}' });
  assert.equal(csrf.status, 403);
  // Formulario de otra web → se bloquea
  const form = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'engage-panel' }, body: 'password=demo' });
  assert.equal(form.status, 415);
  // JSON roto
  const broken = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'engage-panel' }, body: '{roto' });
  assert.equal(broken.status, 400);
  assert.equal((await req('/api/login', { method: 'POST', body: { password: 'mala' } })).status, 401);
  const ok = await req('/api/login', { method: 'POST', body: { password: 'demo' } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /eng_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
  cookie = setCookie.split(';')[0];
  s = await req('/api/session');
  assert.equal(s.json.authenticated, true);
  assert.equal(s.json.user.owner, true);
  // Cookie manipulada → no vale
  const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  const t = await fetch(`${base}/api/guilds`, { headers: { cookie: tampered } });
  assert.equal(t.status, 401);
});

test('servidores, resumen, metadatos y ajustes', async () => {
  const g = await req('/api/guilds');
  assert.equal(g.json.guilds.length, 1);
  assert.equal(g.json.guilds[0].pendingReviews, 1);
  const o = await req(`/api/guilds/${gid}/overview`);
  assert.equal(o.status, 200);
  assert.equal(o.json.daily.length, 14);
  assert.ok(o.json.counts.verified > 0);
  const m = await req(`/api/guilds/${gid}/meta`);
  assert.equal(m.json.channels.length, 3);
  assert.equal(m.json.online, true);
  const bad = await req(`/api/guilds/${gid}/settings`, { method: 'PUT', body: { logChannelId: 'x', verification: { proofMode: 'hack' } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.errors.length, 2);
  const good = await req(`/api/guilds/${gid}/settings`, { method: 'PUT', body: { verification: { minReplyQuality: 40 } } });
  assert.equal(good.json.settings.verification.minReplyQuality, 40);
  assert.equal((await req('/api/guilds/abc/meta')).status, 400);
  const st = await req('/api/status');
  assert.equal(st.json.bot.kind, 'simulator');
  assert.ok(st.json.memory.heapUsed > 0);
  assert.equal((await req('/api/invite')).json.url, null);
  const q = await req('/api/quality', { method: 'POST', body: { text: 'gm' } });
  assert.ok(q.json.score < 35);
});

test('tareas: listado, detalle, CSV, operaciones y creación', async () => {
  const list = await req(`/api/guilds/${gid}/tasks`);
  assert.equal(list.json.total, 2);
  assert.equal((await req(`/api/guilds/${gid}/tasks?status=closed`)).json.total, 1);
  assert.equal((await req(`/api/guilds/${gid}/tasks?search=torneo`)).json.total, 1);
  const d = await req(`/api/guilds/${gid}/tasks/1`);
  assert.equal(d.json.stats.completed, 5);
  assert.equal(d.json.stats.missing, 3);
  assert.ok(d.json.rows.find((r) => r.state === 'partial'));
  assert.equal((await req(`/api/guilds/${gid}/tasks/999`)).status, 404);
  const csv = await req(`/api/guilds/${gid}/tasks/1/export.csv`);
  assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.ok(csv.text.startsWith('id_discord;nombre;cuenta_x;estado'));
  const bytes = Buffer.from(await (await req(`/api/guilds/${gid}/tasks/1/export.csv`, { raw: true })).arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'lleva BOM para que Excel lea bien los acentos');
  assert.equal(csv.text.trim().split('\r\n').length, 10);

  const tweetUrl = app.sim.brandPosts[2].url;
  const prev = await req('/api/tweet-preview', { method: 'POST', body: { url: tweetUrl } });
  assert.match(prev.json.tweet.text, /contratando/);
  assert.equal((await req('/api/tweet-preview', { method: 'POST', body: { url: 'hola' } })).status, 400);
  const pv = await req(`/api/guilds/${gid}/tasks/preview`, { method: 'POST', body: { tweet: prev.json.tweet, actions: ['like'], duration: '30m' } });
  assert.equal(pv.json.payload.embeds.length, 1);
  const created = await req(`/api/guilds/${gid}/tasks`, { method: 'POST', body: { tweetUrl, actions: ['like', 'reply'], duration: '1h', note: 'desde el panel' } });
  assert.equal(created.status, 201);
  const id = created.json.task.id;
  assert.equal((await req(`/api/guilds/${gid}/tasks`, { method: 'POST', body: { tweetUrl } })).status, 400, 'duplicada');
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/extend`, { method: 'POST', body: { duration: '30m' } })).json.ok, true);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/remind`, { method: 'POST' })).json.targets, 9);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/remind`, { method: 'POST' })).status, 400, 'enfriamiento');
  const lucia = app.sim.ids.users.lucia;
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/manual`, { method: 'POST', body: { userId: lucia, action: 'like', done: true } })).json.ok, true);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/manual`, { method: 'POST', body: { userId: lucia, action: 'nope', done: true } })).status, 400);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/recheck`, { method: 'POST' })).json.ok, true);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/nada`, { method: 'POST' })).status, 404);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/close`, { method: 'POST' })).json.task.status, 'closed');
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}/cancel`, { method: 'POST' })).status, 400);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}`, { method: 'DELETE' })).json.ok, true);
  assert.equal((await req(`/api/guilds/${gid}/tasks/${id}`)).status, 404);
});

test('revisiones y capturas protegidas', async () => {
  const r = await req(`/api/guilds/${gid}/reviews`);
  assert.equal(r.json.items.length, 1);
  const item = r.json.items[0];
  const img = await req(item.proofUrl, { raw: true });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + item.proofUrl)).status, 401, 'sin sesión no se ve');
  assert.equal((await req('/api/proofs/..%2F..%2Fengage.db')).status, 404);
  assert.equal((await req('/api/proofs/no-existe.png')).status, 404);
  const ok = await req(`/api/guilds/${gid}/reviews/${item.id}`, { method: 'POST', body: { approve: true } });
  assert.equal(ok.json.submission.status, 'verified');
  assert.equal((await req(`/api/guilds/${gid}/reviews/${item.id}`, { method: 'POST', body: { approve: true } })).status, 400);
  assert.equal((await req(`/api/guilds/${gid}/reviews`)).json.items.length, 0);
});

test('miembros, ranking y actividad', async () => {
  const list = await req(`/api/guilds/${gid}/members?sort=trust`);
  assert.equal(list.json.total, 9);
  assert.equal((await req(`/api/guilds/${gid}/members?search=lucia`)).json.total, 1);
  const uid = app.sim.ids.users.hugo;
  const d = await req(`/api/guilds/${gid}/members/${uid}`);
  assert.equal(d.json.link.handle, 'hugo_x');
  assert.ok(d.json.submissions.length > 0);
  assert.equal((await req(`/api/guilds/${gid}/members/${uid}`, { method: 'PATCH', body: { trust: 500, blacklisted: true, notes: 'ojo' } })).json.member.trust, 100);
  assert.equal((await req(`/api/guilds/${gid}/members/${uid}`, { method: 'PATCH', body: { trust: 'x' } })).status, 400);
  const pts = await req(`/api/guilds/${gid}/members/${uid}/points`, { method: 'POST', body: { amount: 40, reason: 'premio' } });
  assert.ok(pts.json.member.points >= 40);
  assert.equal((await req(`/api/guilds/${gid}/members/${uid}/points`, { method: 'POST', body: { amount: 0 } })).status, 400);
  assert.equal((await req(`/api/guilds/${gid}/members/${uid}/link`, { method: 'PUT', body: { handle: '@nueva_cuenta' } })).json.link.handle, 'nueva_cuenta');
  assert.equal((await req(`/api/guilds/${gid}/members/${uid}/link`, { method: 'PUT', body: { handle: 'no válido!' } })).status, 400);
  assert.equal((await req(`/api/guilds/${gid}/members/${uid}/link`, { method: 'DELETE' })).json.ok, true);
  assert.equal((await req(`/api/guilds/${gid}/members/123456789`)).status, 404);
  const lb = await req(`/api/guilds/${gid}/leaderboard?period=week`);
  assert.ok(lb.json.items.length > 0);
  const act = await req(`/api/guilds/${gid}/activity`);
  assert.ok(act.json.items.length > 0);
  const older = await req(`/api/guilds/${gid}/activity?before=${act.json.items.at(-1).id}&type=task`);
  assert.equal(older.status, 200);
  const mentions = await req(`/api/guilds/${gid}/mentions`, { method: 'POST', body: { texts: [`hola <@${uid}>`] } });
  assert.equal(mentions.json.users[uid], 'Hugo');
});

test('eventos en vivo: llegan y la conexión se libera al cerrar', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events?guild=${gid}`, { headers: { cookie }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      if (buf.includes('event: change') && buf.includes('event: audit')) return buf;
    }
    return buf;
  })();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.web.live.clients.size, 1);
  await req(`/api/guilds/${gid}/members/${app.sim.ids.users.leo}/points`, { method: 'POST', body: { amount: 1 } });
  const buf = await got;
  assert.match(buf, /event: change/);
  assert.match(buf, /event: audit/);
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(app.web.live.clients.size, 0, 'no quedan conexiones colgando');
  assert.equal(app.engine.bus.listenerCount('change'), 0, 'no quedan oyentes (sin fugas de memoria)');
  assert.equal((await req('/api/events?guild=555555555555555555', { raw: true })).status, 200, 'el propietario ve todos los servidores');
});

test('simulador por API', async () => {
  const s = await req(`/api/sim/state?user=${app.sim.ids.users.leo}`);
  assert.equal(s.json.userId, app.sim.ids.users.leo);
  assert.ok(s.json.commands.length >= 10);
  const r = await req('/api/sim/command', { method: 'POST', body: { userId: app.sim.ids.users.leo, name: 'perfil' } });
  assert.equal(r.json.ok, true);
  const bio = await req('/api/sim/x', { method: 'POST', body: { userId: app.sim.ids.users.leo, type: 'bio', text: 'hola' } });
  assert.equal(bio.json.bio, 'hola');
  assert.equal((await req('/api/sim/x', { method: 'POST', body: { userId: app.sim.ids.users.leo, type: 'reply', tweetId: '1', text: '' } })).status, 400);
});

test('Discord OAuth2: sólo ve los servidores que administra', async () => {
  const start = await req('/auth/discord', { raw: true, noCookie: true });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.hostname, 'discord.com');
  assert.equal(loc.searchParams.get('scope'), 'identify guilds');
  const state = loc.searchParams.get('state');
  const stateCookie = start.headers.get('set-cookie').split(';')[0];
  // Estado falso → error
  const bad = await fetch(`${base}/auth/discord/callback?code=buen-codigo&state=otro`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  assert.match(bad.headers.get('location'), /error=state/);
  // Código inválido → error
  const badCode = await fetch(`${base}/auth/discord/callback?code=malo&state=${state}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  assert.match(badCode.headers.get('location'), /error=token/);
  // Correcto
  const cb = await fetch(`${base}/auth/discord/callback?code=buen-codigo&state=${state}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  assert.equal(cb.headers.get('location'), '/#/');
  const modCookie = cb.headers.getSetCookie().find((c) => c.startsWith('eng_session=')).split(';')[0];
  const guilds = await fetch(`${base}/api/guilds`, { headers: { cookie: modCookie } }).then((r) => r.json());
  assert.deepEqual(guilds.guilds.map((g) => g.id), [gid]);
  const forbidden = await fetch(`${base}/api/guilds/555555555555555555/meta`, { headers: { cookie: modCookie } });
  assert.equal(forbidden.status, 403, 'no puede entrar en servidores que no administra');
  const revoke = await fetch(`${base}/api/sessions/revoke`, { method: 'POST', headers: { cookie: modCookie, 'x-requested-with': 'engage-panel' } });
  assert.equal(revoke.status, 403, 'sólo el propietario puede cerrar todas las sesiones');
});

test('cerrar sesión y revocar todas las sesiones', async () => {
  const out = await req('/api/logout', { method: 'POST' });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  const again = await req('/api/login', { method: 'POST', body: { password: 'demo' }, noCookie: true });
  cookie = again.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/sessions/revoke', { method: 'POST' })).json.ok, true);
  assert.equal((await req('/api/guilds')).status, 401, 'la sesión anterior ya no vale');
});

test('límite de intentos de contraseña', async () => {
  const ip = { 'x-forwarded-for': '1.2.3.4' };
  let last;
  for (let i = 0; i < 9; i++) last = await req('/api/login', { method: 'POST', body: { password: 'no' }, headers: ip, noCookie: true });
  assert.equal(last.status, 429);
  assert.match(last.json.error, /Demasiados intentos/);
});
