'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Events, ApplicationFlagsBitField } = require('discord.js');
const { startDiscord, membersIntentEnabled } = require('../src/discord/client');
const { commandsJSON } = require('../src/discord/commands');
const ui = require('../src/discord/ui');
const { XService } = require('../src/twitter/service');
const { XError } = require('../src/twitter/errors');
const { retryAfterMs } = require('../src/twitter/http');
const { createFxTwitterProvider } = require('../src/twitter/providers/fxtwitter');
const { createSyndicationProvider } = require('../src/twitter/providers/syndication');
const { Simulator } = require('../src/sim/simulator');
const { LiveEvents } = require('../src/web/sse');
const { Database } = require('../src/db/database');
const { MIGRATIONS } = require('../src/db/migrations');
const { Store } = require('../src/core/store');
const { main } = require('../src/index');
const { G, createEngine, linkedUser, reply, GOOD, tmpDir } = require('./helpers');

test('Server Members detects both Discord application flags', () => {
  assert.equal(membersIntentEnabled(0), false);
  assert.equal(membersIntentEnabled(1 << 14), true);
  assert.equal(membersIntentEnabled(1 << 15), true);
  assert.equal(membersIntentEnabled(new ApplicationFlagsBitField(1 << 15)), true);
  assert.equal(membersIntentEnabled(1 << 19), false);
});

test('enabling members intent after startup replaces the fallback session and releases listeners', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  let flags = 0;
  const calls = [];
  const client = () => Object.assign(new EventEmitter(), {
    user: { id: '123456789', tag: 'Test#0001', setPresence() {}, displayAvatarURL: () => null },
    guilds: { cache: new Map() },
    application: { fetch: async () => ({ flags: new ApplicationFlagsBitField(flags) }) },
    isReady: () => true,
    async destroy() { this.destroyed = true; },
  });
  const fallback = client();
  const enabled = client();
  let registeredId;
  const runtime = await startDiscord({
    engine: ctx.engine,
    config: { discord: { token: 'test', clientId: 'wrong-app-id' } },
    log: ctx.engine.log,
    connectClient: async (_token, members) => {
      calls.push(members);
      if (members && !flags) throw Object.assign(new Error('Disallowed intents'), { code: 'DisallowedIntents' });
      return members ? enabled : fallback;
    },
    register: async ({ clientId }) => { registeredId = clientId; },
  });
  t.after(() => runtime.stop());
  await runtime.refreshMembersIntent();
  assert.equal(runtime.membersIntent, false);
  assert.equal(runtime.gateway.intentStatus.portalEnabled, false);
  flags = 1 << 15;
  await Promise.all([runtime.refreshMembersIntent(), runtime.refreshMembersIntent()]);
  assert.equal(runtime.membersIntent, true);
  assert.equal(runtime.gateway.membersIntent, true);
  assert.equal(runtime.client, enabled);
  assert.equal(runtime.gateway.client, enabled);
  assert.equal(fallback.destroyed, true);
  assert.equal(fallback.listenerCount(Events.InteractionCreate), 0);
  assert.equal(enabled.listenerCount(Events.InteractionCreate), 1);
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(registeredId, enabled.user.id, 'commands target the authenticated bot, even with a stale configured ID');
  await runtime.stop();
  assert.equal(enabled.listenerCount(Events.InteractionCreate), 0);
});

test('emoji replies await human review without spending attempts or reducing trust', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const user = await linkedUser(ctx, 'emoji');
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['reply'] });
  const post = reply(ctx, user, task, '🔥🔥');
  const before = ctx.engine.store.getMember(G, user.id);
  const result = await ctx.engine.verification.verify({ task, user, inputs: { reply: post.url } });
  const sub = ctx.engine.store.userSubmissions(task.id, user.id)[0];
  const after = ctx.engine.store.getMember(G, user.id);
  assert.equal(result.results[0].state, 'pending');
  assert.equal(sub.attempts, 0);
  assert.equal(sub.evidenceId, post.id);
  assert.equal(sub.evidenceText, '🔥🔥');
  assert.equal(after.trust, before.trust);
  assert.equal(after.rejected, before.rejected);
  assert.equal(after.points, before.points);
  ctx.engine.verification.review(G, sub.id, { approve: true, reviewer: { name: 'Staff' } });
  assert.equal(ctx.engine.store.taskPointsFor(task.id, user.id), task.points.reply + task.points.bonus);
});

test('an invalid replacement preserves pending evidence; edited posts can be checked again', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const user = await linkedUser(ctx, 'revised');
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['reply'] });
  const post = reply(ctx, user, task, '🔥');
  const verify = (url) => ctx.engine.verification.verify({ task, user, inputs: { reply: url } });
  await verify(post.url);
  const first = ctx.engine.store.userSubmissions(task.id, user.id)[0];
  await verify('typo');
  const kept = ctx.engine.store.userSubmissions(task.id, user.id)[0];
  assert.equal(kept.status, 'pending');
  assert.equal(kept.evidenceId, first.evidenceId);
  assert.equal(kept.attempts, 0);
  await verify(post.url);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.publisher.of('reviewRequest').length, 1, 'same pending post does not spam staff');
  ctx.mock.tweets.get(post.id).text = GOOD[0];
  assert.equal((await verify(post.url)).results[0].state, 'verified');
});

test('the bot exposes English commands and point options without dashboard links', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const sim = new Simulator({ engine: ctx.engine, mock: ctx.mock, config: { discord: { ownerIds: [] } }, log: ctx.engine.log });
  sim.attach();
  sim.seed();
  const staff = sim.ids.users['ana.staff'];
  const guildId = sim.guildId;
  sim.handler.cooldown = { hit: () => 0 };
  await sim.command({ userId: staff, name: 'points', options: { like: 4, reply: 12, bonus: 0 } });
  assert.equal(ctx.engine.store.getSettings(guildId).points.reply, 12);
  await sim.command({ userId: sim.ids.users.lucia, name: 'points', options: { reply: 99 } });
  assert.equal(ctx.engine.store.getSettings(guildId).points.reply, 12, 'members cannot configure rewards');
  await sim.command({ userId: staff, name: 'task', subcommand: 'create', options: { url: sim.brandPosts[0].url, 'reply-points': 25, 'like-points': 0, 'bonus-points': 7 } });
  const task = ctx.engine.store.activeTasks(guildId)[0];
  assert.deepEqual([task.points.like, task.points.reply, task.points.bonus], [0, 25, 7]);
  assert.equal(ctx.engine.store.getSettings(guildId).points.reply, 12, 'per-post rewards do not change defaults');
  const commands = commandsJSON();
  assert.ok(commands.some((command) => command.name === 'points'));
  assert.ok(!commands.some((command) => ['panel', 'dashboard', 'ayuda', 'tarea'].includes(command.name)));
  const text = JSON.stringify([ui.helpMessage({ staff: true, dashboardUrl: 'https://private.example' }), ui.configMessage(ctx.engine.store.getSettings(guildId), { dashboardUrl: 'https://private.example' })]);
  assert.doesNotMatch(text, /private\.example|\/panel|dashboard/i);
});

test('429 response headers are respected across provider methods, including HTML error pages', async () => {
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '123' })), 123000);
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'invalid' })), null);
  const fetchImpl = async () => new Response('<html>rate limited</html>', { status: 429, headers: { 'retry-after': '37' } });
  for (const provider of [createFxTwitterProvider({ fetchImpl }), createSyndicationProvider({ fetchImpl })]) {
    await assert.rejects(provider.getTweet('123'), (err) => err.code === 'RATE_LIMITED' && err.retryAfterMs === 37000);
  }
  let profileCalls = 0;
  const service = new XService({ providers: [{ name: 'source', getTweet: async () => { throw new XError('RATE_LIMITED', 'Rate limit', { retryAfterMs: 37000 }); }, getProfile: async () => { profileCalls++; return {}; } }] });
  await assert.rejects(service.getTweet('1'), { code: 'RATE_LIMITED' });
  await assert.rejects(service.getProfile('user'), { code: 'RATE_LIMITED' });
  assert.equal(profileCalls, 0);
  assert.equal(service.status().providers[0].state, 'rate_limited');
  service.pausedUntil.set('source', Date.now() - 1);
  assert.equal(service.status().providers[0].state, 'retry_ready');
  await service.getProfile('user');
  assert.equal(service.status().providers[0].state, 'ok');
});

test('slow or disconnected live clients release listeners instead of buffering indefinitely', () => {
  const bus = new EventEmitter();
  const live = new LiveEvents({ bus, auth: { canAccessGuild: () => true } });
  const req = Object.assign(new EventEmitter(), { query: { guild: G }, session: {} });
  const res = Object.assign(new EventEmitter(), { writableLength: 0, writeHead() {}, write() {}, destroy() { this.destroyed = true; this.emit('close'); } });
  live.handler()(req, res);
  assert.equal(live.clients.size, 1);
  res.writableLength = 70000;
  bus.emit('change', { guildId: G });
  assert.equal(live.clients.size, 0);
  assert.equal(res.destroyed, true);
  assert.equal(bus.listenerCount('change'), 0);
  assert.equal(bus.listenerCount('audit'), 0);
  assert.equal(req.listenerCount('close'), 0);
});

test('simultaneous task creation publishes the X post only once', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const input = { guildId: G, tweetUrl: ctx.brand.url };
  const results = await Promise.allSettled([ctx.engine.tasks.create(input), ctx.engine.tasks.create(input)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(ctx.publisher.of('postTask').length, 1);
  assert.equal(ctx.engine.tasks.creationLock.size, 0);
});

test('X outages do not spend account-link attempts', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  const user = { id: '456789012345678901', username: 'link-test' };
  ctx.mock.addProfile({ handle: 'link_test' });
  ctx.engine.links.start(user, G, 'link_test');
  ctx.mock.failNext = 'RATE_LIMITED';
  await assert.rejects(ctx.engine.links.verifyBio(user), { code: 'X_RATE_LIMITED' });
  assert.equal(ctx.engine.store.getLinkRequest(user.id).attempts, 0);
});

test('existing automatic quality rejections are recovered once without overriding staff decisions', () => {
  const db = new Database(':memory:');
  try {
    db.exec(MIGRATIONS[0]);
    db.exec('PRAGMA user_version = 1');
    const store = new Store(db);
    store.upsertGuild({ id: G, name: 'Legacy' });
    const task = store.insertTask({ guildId: G, tweetId: '123456', tweetUrl: 'https://x.com/u/status/123456', tweet: {}, actions: ['reply'], points: {}, createdAt: Date.now(), endsAt: Date.now() + 60000 });
    for (const userId of ['one', 'staff-decided']) {
      store.ensureMember(G, userId);
      store.updateMember(G, userId, { trust: 48 });
      store.incMember(G, userId, 'rejected', 1);
      store.upsertSubmission({ taskId: task.id, guildId: G, userId, action: 'reply', status: 'rejected', method: 'auto', evidenceUrl: 'https://x.com/u/status/789012', evidenceText: '🔥', quality: 3, reason: 'Tu comentario tiene una calidad de 3/100 (mínimo 35). Sólo contiene emojis.', reviewerId: userId === 'staff-decided' ? 'staff' : null });
    }
    db.migrate();
    const recovered = store.userSubmissions(task.id, 'one')[0];
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.details.qualityReview, true);
    assert.equal(recovered.attempts, 0);
    assert.equal(store.getMember(G, 'one').trust, 50);
    assert.equal(store.getMember(G, 'one').rejected, 0);
    assert.equal(store.userSubmissions(task.id, 'staff-decided')[0].status, 'rejected');
    db.migrate();
    assert.equal(store.getMember(G, 'one').trust, 50, 'restarting does not restore the same penalty twice');
  } finally { db.close(); }
});

test('shutdown waits for scheduled work and pending review writes', async (t) => {
  const ctx = createEngine();
  t.after(() => ctx.close());
  let releaseJob;
  ctx.engine.scheduler.track(new Promise((resolve) => { releaseJob = resolve; }));
  let stopped = false;
  const stopping = ctx.engine.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseJob();
  await stopping;
  assert.equal(ctx.engine.scheduler.activeJobs.size, 0);

  const user = await linkedUser(ctx, 'shutdown');
  const task = await ctx.engine.tasks.create({ guildId: G, tweetUrl: ctx.brand.url, actions: ['reply'] });
  let releaseReview;
  ctx.publisher.reviewRequest = () => new Promise((resolve) => { releaseReview = resolve; });
  await ctx.engine.verification.verify({ task, user, inputs: { reply: reply(ctx, user, task, '🔥').url } });
  let idle = false;
  const draining = ctx.engine.verification.idle().then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  releaseReview({ channelId: '12345', messageId: '67890' });
  await draining;
  assert.equal(ctx.engine.store.userSubmissions(task.id, user.id)[0].details.reviewMessage.messageId, '67890');
  assert.equal(ctx.engine.verification.background.size, 0);
});

test('repeated stop calls share cleanup and release process signal listeners', async () => {
  const events = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException'];
  const before = events.map((event) => process.listenerCount(event));
  const dataDir = tmpDir('engage-stop-');
  let app;
  try {
    app = await main({ demo: true, overrides: { dataDir, port: 0, logLevel: 'silent', logToFile: false } });
    const first = app.stop();
    const second = app.stop();
    assert.equal(first, second);
    await first;
    assert.deepEqual(events.map((event) => process.listenerCount(event)), before);
    assert.equal(app.engine.scheduler.activeJobs.size, 0);
    assert.equal(app.db.closed, true);
  } finally {
    await app?.stop();
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('engage-stop-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
});
