'use strict';

// Browser regression checks against isolated demo data; no Discord/X traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { main } = require('../src/index');

async function run() {
  const executablePath = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
  if (!executablePath) throw new Error('Set BROWSER_PATH to a Chrome or Edge executable.');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engage-ui-'));
  const out = path.resolve(process.env.UI_QA_OUT || '.codex-backups/ui-qa');
  fs.mkdirSync(out, { recursive: true });
  const app = await main({ demo: true, handleSignals: false, overrides: { dataDir, port: 0, logLevel: 'silent', logToFile: false } });
  let browser;
  const errors = [];
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run'] });
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const base = `http://127.0.0.1:${app.web.port}`;
    await page.setViewport({ width: 1440, height: 960 });
    await page.goto(base, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#login-form');
    await page.select('#login [data-language]', 'en');
    await page.waitForFunction(() => document.querySelector('#login h1').textContent === 'Engage dashboard');
    await page.type('#pw', 'demo');
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#view .kpi');
    const gid = app.sim.guildId;
    const routes = ['resumen', 'tareas', 'tareas/1', 'tareas/nueva', 'revision', 'miembros', `miembros/${app.sim.ids.users.lucia}`, 'ranking', 'actividad', 'ajustes'];
    for (const route of routes) {
      await page.evaluate((hash) => { location.hash = hash; }, `/g/${gid}/${route}`);
      await page.waitForFunction(() => !document.querySelector('#app').classList.contains('is-loading'));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const content = await page.$eval('#view', (el) => el.innerText);
      fs.writeFileSync(path.join(out, `${route.replaceAll('/', '-')}-en.txt`), content);
      assert.ok(!content.includes('Could not load this page'), route);
    }
    await page.$eval('[name=p_like]', (el) => { el.value = '17'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.select('#topbar-actions [data-language]', 'es');
    assert.equal(await page.$eval('[name=p_like]', (el) => el.value), '17', 'language switch preserves unsaved settings');
    await page.select('#topbar-actions [data-language]', 'en');
    assert.equal(await page.$eval('[name=p_like]', (el) => el.value), '17');

    // Exercise the live log's bound in both data and DOM, including a long-lived tab.
    await page.evaluate((hash) => { location.hash = hash; }, `/g/${gid}/actividad`);
    await page.waitForSelector('.activity-scroll');
    await page.evaluate(async (guildId) => {
      const { default: activity } = await import('/js/pages/activity.js');
      for (let i = 0; i < 650; i++) await activity.onAudit({ id: 1_000_000 + i, guildId, type: 'task', message: `Task #${i}`, createdAt: Date.now() });
    }, gid);
    assert.equal(await page.$$eval('.activity-scroll > *', (els) => els.length), 500);
    const scrollable = await page.$eval('.activity-scroll', (el) => ({ scroll: el.scrollHeight > el.clientHeight, overflow: getComputedStyle(el).overflowY }));
    assert.equal(scrollable.scroll, true);
    assert.equal(scrollable.overflow, 'scroll');

    await page.evaluate(() => { location.hash = '/estado'; });
    app.log.root.recent = Array.from({ length: 100 }, (_, i) => ({ t: Date.now(), level: 'info', scope: 'qa', msg: `Log entry ${i}: scroll regression check` }));
    await page.waitForSelector('.status-grid');
    await page.waitForSelector('.log-box');
    await page.$eval('.log-box', (el) => { el.scrollTop = 250; });
    await page.evaluate(async () => { await (await import('/js/pages/status.js')).default.onLocale(); });
    assert.ok(await page.$eval('.log-box', (el) => el.scrollTop > 0), 'status refresh preserves log scroll');
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewport({ width, height: 900 });
      const dims = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dims.scroll <= dims.width + 1, `status horizontal overflow at ${width}: ${JSON.stringify(dims)}`);
      if (width <= 640) assert.ok(await page.$eval('.topbar-actions', (el) => el.getBoundingClientRect().height < 50), 'mobile controls fit in one row');
      if (width === 1440 || width === 390) await page.screenshot({ path: path.join(out, `status-${width}-en.png`), fullPage: true });
    }
    await page.setViewport({ width: 1440, height: 960 });
    await page.select('#topbar-actions [data-language]', 'es');
    await page.waitForFunction(() => document.querySelector('#page-title').textContent === 'Estado del bot');
    await page.screenshot({ path: path.join(out, 'status-1440-es.png'), fullPage: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.status-grid');
    assert.equal(await page.$eval('html', (el) => el.lang), 'es', 'language is remembered');
    assert.deepEqual(errors, [], 'browser JavaScript errors');
    console.log(`UI passed: EN/ES, saved forms, 650 live events, status at 5 widths. Artifacts: ${out}`);
  } finally {
    await browser?.close();
    await app.stop();
    const resolved = path.resolve(dataDir);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('engage-ui-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
