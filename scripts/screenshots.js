'use strict';

/**
 * Prueba visual de extremo a extremo + capturas para la guía.
 * Arranca la demo, abre un navegador real (Edge/Chrome sin ventana), usa el panel y el simulador
 * como lo haría una persona (clics, formularios, comandos) y guarda capturas en docs/img/.
 * Falla si aparece cualquier error en la consola del navegador o una petición falla.
 *
 *   npm run capturas
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/index');

const OUT = path.join(__dirname, '..', 'docs', 'img');
const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
let currentPage = null;

async function run() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    console.error('Instala las dependencias de desarrollo: npm install');
    process.exit(1);
  }
  const executablePath = BROWSERS.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('No se encontró Edge ni Chrome. Indica la ruta con BROWSER_PATH.');
  fs.mkdirSync(OUT, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engage-shots-'));
  const app = await main({ demo: true, handleSignals: false, overrides: { dataDir, port: 0, logLevel: 'warn', logToFile: false } });
  const base = `http://127.0.0.1:${app.web.port}`;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-first-run', '--hide-scrollbars', '--lang=es-ES'] });
  const page = await browser.newPage();
  currentPage = page;
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  page.on('console', (m) => {
    // Los códigos HTTP se revisan aparte (algunos 4xx son esperados, p. ej. la contraseña incorrecta).
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`consola: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`error JS: ${e.message}`));
  if (process.env.DEBUG_SIM) {
    page.on('response', async (r) => {
      if (r.url().includes('/api/sim/') && !r.url().includes('/state')) console.log('   ↪', r.url().split('/api/')[1], (await r.text().catch(() => '')).slice(0, 300));
    });
  }
  page.on('response', (r) => {
    const u = r.url();
    // 400 esperados: los formularios de prueba con datos incorrectos
    if (r.status() >= 500 || (r.status() >= 400 && !/\/api\/(login|sim|guilds\/\d+\/tasks$)/.test(u) && !u.startsWith('https://'))) problems.push(`HTTP ${r.status()} ${u}`);
  });

  let n = 0;
  const shot = async (name, opts = {}) => {
    n += 1;
    const file = path.join(OUT, `${name}.png`);
    if (opts.el) {
      const el = await page.$(opts.el);
      if (!el) throw new Error(`No existe ${opts.el} para la captura ${name}`);
      await el.screenshot({ path: file });
    } else {
      await page.screenshot({ path: file, fullPage: Boolean(opts.full) });
    }
    console.log(`  📸 ${name}.png`);
  };
  /** Captura un mensaje del chat copiándolo a un contenedor fijo (sin recortes por el scroll). */
  const shotMsg = async (name) => {
    await page.evaluate(() => {
      const src = [...document.querySelectorAll('#sim-msgs .dc-msg')].at(-1);
      const holder = document.createElement('div');
      holder.id = '__shot';
      holder.className = 'dc';
      holder.style.cssText = 'position:absolute;left:0;top:0;width:620px;z-index:9999;padding:10px 0;border-radius:0';
      holder.appendChild(src.cloneNode(true));
      document.body.appendChild(holder);
      window.scrollTo(0, 0);
    });
    await shot(name, { el: '#__shot' });
    await page.evaluate(() => document.getElementById('__shot')?.remove());
  };
  const go = async (hash, wait = '.view > *') => {
    await page.goto(`${base}/#${hash}`);
    await page.waitForSelector(wait, { timeout: 10000 });
    await sleep(900);
  };
  const clickText = async (selector, text, { last = true } = {}) => {
    const ok = await page.evaluate(
      (sel, txt, lst) => {
        const all = [...document.querySelectorAll(sel)].filter((e) => e.textContent.replace(/\s+/g, ' ').includes(txt) && !e.disabled);
        const el = lst ? all.at(-1) : all[0];
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      },
      selector,
      text,
      last,
    );
    if (!ok) throw new Error(`No se encontró "${text}" en ${selector}`);
    await sleep(700);
  };
  const lastMsgText = () => page.evaluate(() => [...document.querySelectorAll('#sim-msgs .dc-msg')].at(-1)?.innerText || '');
  const expectLast = async (re, what) => {
    const t = await lastMsgText();
    if (!re.test(t)) throw new Error(`Esperaba ${what} y el último mensaje es: ${t.slice(0, 300)}`);
  };

  // ── 1. Inicio de sesión ─────────────────────────────
  console.log('Panel web');
  await page.goto(base);
  await page.waitForSelector('#pw');
  await shot('01-login');
  await page.type('#pw', 'contraseña-mala');
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#login-msg').textContent.length > 0);
  await page.$eval('#pw', (e) => (e.value = ''));
  await page.type('#pw', 'demo');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('.kpi');
  await sleep(1200);
  const gid = await page.evaluate(() => location.hash.split('/')[2]);

  // ── 2. Páginas del panel ────────────────────────────
  await shot('02-resumen');
  await go(`/g/${gid}/tareas`, '.task-card');
  await shot('03-tareas');
  await go(`/g/${gid}/tareas/1`, '.table');
  await shot('04-tarea-cerrada', { full: true });
  await go(`/g/${gid}/tareas/2`, '.table');
  await shot('05-tarea-activa');
  await clickText('[data-act=cell]', '📸', { last: false }).catch(() => clickText('[data-act=cell]', '🕓', { last: false }));
  await page.waitForSelector('.modal');
  await sleep(500);
  await shot('06-detalle-accion', { el: '.modal' });
  await page.keyboard.press('Escape');
  await go(`/g/${gid}/revision`, '.card');
  await shot('07-revision');
  await go(`/g/${gid}/miembros`, '.table');
  await shot('08-miembros');
  await page.click('tr.clickable');
  await page.waitForSelector('.kpi');
  await sleep(800);
  await shot('09-miembro');
  await go(`/g/${gid}/ranking`, '.table');
  await shot('10-ranking');
  await go(`/g/${gid}/actividad`, '.feed');
  await shot('11-actividad');
  await go(`/g/${gid}/ajustes`, '#settings-form');
  await page.type('#q-text', 'gm 🔥🔥');
  await sleep(900);
  await shot('12-ajustes', { full: true });
  await go('/estado', '.card');
  await shot('13-estado');

  // Nueva tarea con vista previa (post de la marca simulada)
  const post = app.sim.brandPosts[2];
  await go(`/g/${gid}/tareas/nueva`, '#new-task');
  await page.type('#url', post.url);
  await page.click('[data-act=load]');
  await page.waitForSelector('#preview .dc-msg', { timeout: 10000 });
  await sleep(800);
  await shot('14-nueva-tarea', { full: true });
  await page.click('#submit-btn');
  await page.waitForFunction(() => /\/tareas\/\d+$/.test(location.hash), { timeout: 10000 });
  await sleep(1000);

  // ── 3. Simulador: la experiencia del miembro en Discord ──
  console.log('Simulador (Discord)');
  await go('/simulador', '#sim-msgs .dc-msg');
  const asUser = (name) => clickText('.sim-user-list button', name, { last: false });
  await asUser('Leo');
  await shot('20-simulador');
  // La tarea recién creada es la última del canal
  await clickText('#sim-msgs .dc-btn', 'Ya lo hice');
  await expectLast(/Primero vincula/, 'el aviso de vincular');
  await shotMsg('21-necesita-vincular');
  await clickText('#sim-msgs .dc-btn', 'Vincular mi cuenta');
  await page.waitForSelector('#sim-modal-form');
  await page.type('#sim-modal-form input[name=handle]', '@leo_x');
  await shot('22-formulario-vincular', { el: '#sim-modal-form' });
  await page.click('#sim-modal-form button[type=submit]');
  await sleep(1200);
  await expectLast(/Vincula tu cuenta de X/, 'las instrucciones de vinculación');
  await shotMsg('23-instrucciones-vincular');
  const code = (await lastMsgText()).match(/ENG-[A-Z0-9]{6}/)[0];
  await page.$eval('#sim-bio', (e) => (e.value = ''));
  await page.type('#sim-bio', `Fan del proyecto · ${code}`);
  await page.click('[data-act=saveBio]');
  await sleep(900);
  await clickText('#sim-msgs .dc-btn', 'Verificar biografía');
  await sleep(600);
  await expectLast(/Cuenta de X vinculada/, 'la confirmación de vinculación');
  await shotMsg('24-cuenta-vinculada');

  // Hace las acciones en X (simulado) y verifica
  const task = app.engine.store.activeTasks(gid).find((t) => t.tweetId === post.id);
  await clickText(`.x-post [data-act=xDo][data-tid="${task.tweetId}"]`, 'Like');
  await clickText(`.x-post [data-act=xDo][data-tid="${task.tweetId}"]`, 'Repost');
  await page.evaluate((tid) => document.querySelector(`.x-post [data-act=xReply][data-type=reply][data-tid="${tid}"]`).click(), task.tweetId);
  await page.waitForSelector('.modal textarea[name=text]');
  await page.type('.modal textarea[name=text]', 'Me interesa mucho el puesto de moderador para la comunidad hispana, ¡os escribo por privado!');
  await page.click('.modal button[type=submit]');
  await sleep(1200);
  const replyUrl = await page.$eval('#sim-last-post code', (e) => e.textContent.trim());
  await shot('25-x-simulado', { el: '.sim-side' });
  // Botón "Ya lo hice" de la tarea nueva (la última publicación de tareas en el canal)
  await page.evaluate((id) => {
    const b = [...document.querySelectorAll('#sim-msgs .dc-btn')].filter((x) => x.dataset.cid === `eng:verify:${id}`).at(-1);
    b.scrollIntoView({ block: 'center' });
    b.click();
  }, task.id);
  await page.waitForSelector('#sim-modal-form input[name=reply]');
  await page.type('#sim-modal-form input[name=reply]', replyUrl);
  await shot('26-formulario-verificar', { el: '#sim-modal-form' });
  await page.click('#sim-modal-form button[type=submit]');
  await sleep(1500);
  await expectLast(/Tarea completada/, 'la tarea completada');
  await shotMsg('27-tarea-completada');

  // Quién falta
  await page.evaluate((id) => [...document.querySelectorAll('#sim-msgs .dc-btn')].filter((x) => x.dataset.cid === `eng:status:${id}`).at(-1).click(), task.id);
  await sleep(1300);
  await expectLast(/quién hizo y quién no/, 'el estado de la tarea');
  await shotMsg('28-quien-falta');

  // Hugo comenta algo sin contenido → rechazo inteligente
  await asUser('Hugo');
  await page.evaluate((tid) => document.querySelector(`.x-post [data-act=xReply][data-type=reply][data-tid="${tid}"]`).click(), task.tweetId);
  await page.waitForSelector('.modal textarea[name=text]');
  await page.type('.modal textarea[name=text]', 'top 🔥🔥🔥');
  await page.click('.modal button[type=submit]');
  await sleep(1200);
  const badUrl = await page.$eval('#sim-last-post code', (e) => e.textContent.trim());
  await page.evaluate((id) => [...document.querySelectorAll('#sim-msgs .dc-btn')].filter((x) => x.dataset.cid === `eng:verify:${id}`).at(-1).click(), task.id);
  await page.waitForSelector('#sim-modal-form input[name=reply]');
  await page.type('#sim-modal-form input[name=reply]', badUrl);
  await page.click('#sim-modal-form button[type=submit]');
  await sleep(1500);
  await expectLast(/calidad de \d+\/100/, 'el rechazo por calidad');
  await shotMsg('29-comentario-rechazado');

  // Staff: comando /tarea estado desde la paleta de comandos
  await asUser('Ana (Staff)');
  await page.click('#sim-input');
  await page.type('#sim-input', '/tarea');
  await sleep(500);
  await shot('30-comandos', { el: '.sim-chat' });
  await clickText('#sim-palette button', '/tarea estado', { last: false });
  await page.waitForSelector('.modal select[name=tarea]');
  await page.select('.modal select[name=tarea]', String(task.id));
  await page.click('.modal button[type=submit]');
  await sleep(1500);
  await expectLast(/quién hizo y quién no/, 'el estado por comando');

  // Revisión de la captura en el canal del staff
  await clickText('.sim-channels button', 'staff-logs', { last: false });
  await sleep(900);
  await shotMsg('31-revision-discord');
  await clickText('#sim-msgs .dc-btn', 'Aprobar');
  await sleep(1200);
  await shotMsg('32-revision-aprobada');

  // Cierre de la tarea → informe final
  await clickText('.sim-channels button', 'tareas-x', { last: false });
  await sleep(500);
  await page.select('#adv-task', String(task.id));
  await page.select('#adv-min', '600');
  await page.click('[data-act=advance]');
  await sleep(2500);
  await page.evaluate(() => {
    const box = document.querySelector('#sim-msgs');
    box.scrollTop = box.scrollHeight;
  });
  await expectLast(/Resultado final/, 'el informe final');
  await shotMsg('33-informe-final');
  await shot('34-simulador-completo');

  // Perfil y ranking
  await asUser('Leo');
  await page.click('#sim-input');
  await page.type('#sim-input', '/perfil');
  await sleep(300);
  await clickText('#sim-palette button', '/perfil', { last: false });
  await page.waitForSelector('.modal');
  await page.click('.modal button[type=submit]');
  await sleep(1200);
  await expectLast(/Perfil de engagement/, 'el perfil');
  await shotMsg('35-perfil');

  // ── 4. Tema claro y móvil ───────────────────────────
  console.log('Tema claro y móvil');
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await go(`/g/${gid}/resumen`, '.kpi');
  await shot('40-resumen-claro');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await go(`/g/${gid}/resumen`, '.kpi');
  await shot('41-movil');
  await page.click('#menu-btn');
  await sleep(500);
  await shot('42-movil-menu');

  await browser.close();
  await app.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n${n} capturas guardadas en docs/img/`);
  if (problems.length) {
    console.error('\n❌ Problemas detectados en el navegador:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('✅ Recorrido visual completo sin errores de consola ni peticiones fallidas.');
  }
}

run().catch(async (err) => {
  console.error('❌ El recorrido visual falló:', err.message);
  try {
    await currentPage?.screenshot({ path: path.join(os.tmpdir(), 'engage-fallo.png') });
    console.error(`Captura del fallo: ${path.join(os.tmpdir(), 'engage-fallo.png')}`);
  } catch {
    /* sin captura */
  }
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 2000).unref();
});
