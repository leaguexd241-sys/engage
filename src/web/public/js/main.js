import { api, get, post, setUnauthorizedHandler } from './api.js';
import { languageSelect, t } from './i18n.js';
import { html, raw, icon, esc, $, toast, avatar, disposeCharts, hideTip } from './ui.js';
import loginPage from './pages/login.js';
import overviewPage from './pages/overview.js';
import tasksPage from './pages/tasks.js';
import taskPage from './pages/task.js';
import newTaskPage from './pages/newtask.js';
import reviewsPage from './pages/reviews.js';
import membersPage from './pages/members.js';
import memberPage from './pages/member.js';
import leaderboardPage from './pages/leaderboard.js';
import activityPage from './pages/activity.js';
import settingsPage from './pages/settings.js';
import statusPage from './pages/status.js';
import simulatorPage from './pages/simulator.js';

// ─── Estado global ────────────────────────────────────────────────
export const state = {
  session: null,
  guilds: [],
  guildId: null,
  meta: null,
  status: null,
  page: null,
  events: null,
};

const ROUTES = [
  { re: /^\/g\/(\d+)\/resumen$/, page: overviewPage, nav: 'resumen' },
  { re: /^\/g\/(\d+)\/tareas\/nueva$/, page: newTaskPage, nav: 'tareas' },
  { re: /^\/g\/(\d+)\/tareas\/(\d+)$/, page: taskPage, nav: 'tareas', keys: ['id'] },
  { re: /^\/g\/(\d+)\/tareas$/, page: tasksPage, nav: 'tareas' },
  { re: /^\/g\/(\d+)\/revision$/, page: reviewsPage, nav: 'revision' },
  { re: /^\/g\/(\d+)\/miembros\/(\d+)$/, page: memberPage, nav: 'miembros', keys: ['uid'] },
  { re: /^\/g\/(\d+)\/miembros$/, page: membersPage, nav: 'miembros' },
  { re: /^\/g\/(\d+)\/ranking$/, page: leaderboardPage, nav: 'ranking' },
  { re: /^\/g\/(\d+)\/actividad$/, page: activityPage, nav: 'actividad' },
  { re: /^\/g\/(\d+)\/ajustes$/, page: settingsPage, nav: 'ajustes' },
  { re: /^\/estado$/, page: statusPage, nav: 'estado', global: true },
  { re: /^\/simulador$/, page: simulatorPage, nav: 'simulador', global: true },
];

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = `#${path}`;
}
export const guildPath = (sub = 'resumen') => `/g/${state.guildId}/${sub}`;

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  const [path, qs] = h.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

// ─── Tema ─────────────────────────────────────────────────────────
function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('engage-theme', next);
  } catch {
    /* sin almacenamiento */
  }
  renderTopbar();
  state.page?.onTheme?.();
}

// ─── Cabecera, barra lateral y avisos ─────────────────────────────
export function setTitle(title, sub = '', { literalTitle = false, literalSub = false } = {}) {
  $('#page-title').toggleAttribute('data-i18n-ignore', literalTitle);
  $('#page-sub').toggleAttribute('data-i18n-ignore', literalSub);
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub;
  document.title = `${literalTitle ? title : t(title)} · Engage`;
}

function botPill() {
  const b = state.status?.bot;
  if (!b) return html`<span class="status-pill"><span class="dot"></span>…</span>`;
  if (b.kind === 'simulator') return html`<a class="status-pill" href="#/simulador" title="Modo simulador"><span class="dot simdot"></span><span class="hide-mobile">Simulador</span></a>`;
  if (b.online) return html`<a class="status-pill" href="#/estado" title="${b.user?.tag || ''}"><span class="dot on"></span><span class="hide-mobile">En línea</span></a>`;
  return html`<a class="status-pill" href="#/estado"><span class="dot off"></span><span class="hide-mobile">Desconectado</span></a>`;
}

function renderTopbar() {
  const actions = $('#topbar-actions');
  actions.innerHTML = String(html`
    ${botPill()}
    ${raw(languageSelect())}
    <button class="icon-btn" data-act="theme" title="Cambiar tema" aria-label="Cambiar tema">${icon(currentTheme() === 'dark' ? 'sun' : 'moon')}</button>
    ${state.guildId ? html`<a class="btn primary" href="#${guildPath('tareas/nueva')}">${icon('plus')}<span class="lbl">Nueva tarea</span></a>` : ''}
  `);
  $('#menu-btn').innerHTML = String(icon('menu'));
}

function renderBanner() {
  const b = state.status?.bot;
  const el = $('#banner');
  if (b && b.kind === 'offline') {
    el.innerHTML = String(html`<div class="banner danger">${icon('alert')}<div><strong>El bot no está conectado a Discord</strong><span class="text-2">${b.error || 'Revisa el token en el archivo .env y reinicia el bot.'} · <a href="#/estado">Ver estado</a> · <a href="/docs/guia.html#instalacion" target="_blank">Guía de instalación</a></span></div></div>`);
  } else if (b && b.kind === 'simulator' && state.session?.demo) {
    el.innerHTML = String(html`<div class="banner info">${icon('flask')}<div><strong>Modo demostración</strong><span class="text-2">Estás usando un servidor de Discord simulado con datos de ejemplo. Pruébalo todo en el <a href="#/simulador">Simulador</a>; nada de esto afecta a Discord ni a X.</span></div></div>`);
  } else if (b && b.kind === 'discord' && b.membersIntent === false) {
    el.innerHTML = String(html`<div class="banner warning">${icon('alert')}<div><strong>${b.intentStatus?.portalEnabled === true ? 'Intent activado: actualizando la conexión' : b.intentStatus?.portalEnabled === false ? 'Discord indica que Server Members está desactivado' : 'Comprobando el intent Server Members'}</strong><span class="text-2">El bot comprueba el estado cada minuto y reconecta automáticamente al activarlo. Comprueba que lo activaste en la aplicación ${b.user?.id || ''}. <a href="#/estado">Ver estado</a></span></div></div>`);
  } else {
    el.innerHTML = '';
  }
}

function renderSidebar(activeNav) {
  closeGuildMenu();
  const g = state.guilds.find((x) => x.id === state.guildId);
  const pending = g?.pendingReviews || 0;
  const item = (key, label, ic, href, extra = '') =>
    html`<a href="${href}" class="${activeNav === key ? 'active' : ''}" data-nav="${key}">${icon(ic)}<span>${label}</span>${extra}</a>`;
  const guildNav = state.guildId
    ? html`
        <div class="nav-label">Servidor</div>
        ${item('resumen', 'Resumen', 'home', `#${guildPath('resumen')}`)}
        ${item('tareas', 'Tareas', 'tasks', `#${guildPath('tareas')}`)}
        ${item('revision', 'Revisión', 'shield', `#${guildPath('revision')}`, pending ? html`<span class="count">${pending}</span>` : '')}
        ${item('miembros', 'Miembros', 'users', `#${guildPath('miembros')}`)}
        ${item('ranking', 'Ranking', 'trophy', `#${guildPath('ranking')}`)}
        ${item('actividad', 'Actividad', 'activity', `#${guildPath('actividad')}`)}
        ${item('ajustes', 'Ajustes', 'settings', `#${guildPath('ajustes')}`)}`
    : html`<div class="nav-label">Servidor</div><p class="small muted" style="padding:0 10px">Invita el bot a un servidor para empezar.</p>`;
  $('#nav').innerHTML = String(html`
    ${guildNav}
    <div class="nav-label">Sistema</div>
    ${item('estado', 'Estado del bot', 'server', '#/estado')}
    ${state.session?.simulator ? item('simulador', 'Simulador', 'flask', '#/simulador') : ''}
    <a href="/docs/guia.html" target="_blank" rel="noopener">${icon('book')}<span>Guía y comandos</span>${icon('external', 'muted')}</a>
  `);

  $('#guild-switch').innerHTML = String(
    g
      ? html`<button class="guild-btn" data-act="guildMenu" aria-haspopup="true">${guildIcon(g)}<span class="name">${g.name}</span>${icon('chevron')}</button>`
      : html`<button class="guild-btn" data-act="guildMenu"><span class="guild-icon">?</span><span class="name">Sin servidores</span></button>`,
  );

  const u = state.session?.user;
  $('#user-box').innerHTML = String(html`
    <div class="user-cell">
      ${avatar(u?.avatar, u?.name, 'sm')}
      <div class="who"><strong>${u?.name || 'Administrador'}</strong><span>${u?.owner ? 'Propietario' : 'Staff'} · ${u?.method === 'discord' ? 'Discord' : 'contraseña'}</span></div>
      <button class="icon-btn" style="margin-left:auto" data-act="logout" title="Cerrar sesión" aria-label="Cerrar sesión">${icon('logout')}</button>
    </div>`);
}

export function guildIcon(g, size = '') {
  if (g?.icon) return html`<img class="guild-icon ${size}" src="${g.icon}" alt="" referrerpolicy="no-referrer" />`;
  return html`<span class="guild-icon ${size}">${String(g?.name || '?').slice(0, 2).toUpperCase()}</span>`;
}

let guildMenuCleanup = null;
function closeGuildMenu() {
  guildMenuCleanup?.();
  guildMenuCleanup = null;
}
function openGuildMenu() {
  const box = $('#guild-switch');
  if (box.querySelector('.menu')) {
    closeGuildMenu();
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = String(html`
    ${state.guilds.map((g) => html`<button data-guild="${g.id}" class="${g.id === state.guildId ? 'active' : ''}">${guildIcon(g)}<span class="ellipsis" style="flex:1">${g.name}</span>${g.activeTasks ? html`<span class="badge info">${g.activeTasks}</span>` : ''}</button>`)}
    ${state.guilds.length ? '' : html`<p class="small muted" style="padding:8px">El bot no está en ningún servidor todavía.</p>`}
    <hr style="margin:6px 0" />
    <button data-act="invite">${icon('plus')}<span>Invitar a otro servidor</span></button>`);
  box.appendChild(menu);
  const close = (e) => {
    if (!box.contains(e.target)) {
      closeGuildMenu();
    }
  };
  document.addEventListener('mousedown', close);
  guildMenuCleanup = () => { menu.remove(); document.removeEventListener('mousedown', close); };
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-guild]');
    if (b) {
      closeGuildMenu();
      const sub = parseHash().path.split('/')[3] || 'resumen';
      navigate(`/g/${b.dataset.guild}/${['tareas', 'revision', 'miembros', 'ranking', 'actividad', 'ajustes'].includes(sub) ? sub : 'resumen'}`);
    }
  });
}

async function inviteBot() {
  try {
    const r = await get('/invite');
    if (r.url) window.open(r.url, '_blank', 'noopener');
    else toast('El enlace de invitación estará disponible cuando el bot esté conectado a Discord.', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Eventos en vivo ──────────────────────────────────────────────
function connectEvents() {
  state.events?.close();
  if (!state.session?.authenticated) return;
  const es = new EventSource(`/api/events${state.guildId ? `?guild=${state.guildId}` : ''}`);
  state.events = es;
  es.addEventListener('change', (e) => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.kind === 'submission' || ev.kind === 'task' || ev.kind === 'guild') scheduleGuildRefresh();
    if (ev.kind === 'settings') state.meta = null;
    state.page?.onLive?.(ev);
  });
  es.addEventListener('audit', (e) => {
    try {
      Promise.resolve(state.page?.onAudit?.(JSON.parse(e.data))).catch(() => {});
    } catch {
      /* ignorar */
    }
  });
}

let guildRefreshTimer = null;
function scheduleGuildRefresh() {
  clearTimeout(guildRefreshTimer);
  guildRefreshTimer = setTimeout(async () => {
    try {
      state.guilds = (await get('/guilds')).guilds;
      const nav = document.querySelector('.nav a.active')?.dataset.nav;
      renderSidebar(nav);
    } catch {
      /* se reintentará con el siguiente evento */
    }
  }, 800);
}

export async function loadMeta(force = false) {
  if (!state.guildId) return null;
  if (!force && state.meta && state.meta.guild?.id === state.guildId) return state.meta;
  const guildId = state.guildId;
  const meta = await get(`/guilds/${guildId}/meta`);
  if (state.guildId === guildId) state.meta = meta;
  return meta;
}

async function refreshStatus() {
  try {
    state.status = await get('/status');
    renderTopbar();
    renderBanner();
  } catch {
    /* sin sesión o sin conexión */
  }
}
window.addEventListener('engage:status', refreshStatus);
window.addEventListener('engage:language', () => {
  const title = $('#page-title');
  document.title = `${title.hasAttribute('data-i18n-ignore') ? title.textContent : t(title.textContent)} · Engage`;
  Promise.resolve(state.page?.onLocale?.()).catch((err) => toast(err.message, 'error'));
});

// ─── Enrutado ─────────────────────────────────────────────────────
let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const { path, query } = parseHash();
  closeMobileMenu();

  if (!state.session?.authenticated) {
    return showLogin(query);
  }
  $('#login').hidden = true;
  $('#app').hidden = false;

  if (path === '/' || path === '/login') {
    const first = state.guilds[0];
    return navigate(first ? `/g/${first.id}/resumen` : '/estado');
  }

  const match = ROUTES.map((r) => ({ r, m: path.match(r.re) })).find((x) => x.m);
  if (!match) return navigate('/');
  const { r, m } = match;
  if (!r.global) {
    const gid = m[1];
    if (!state.guilds.some((g) => g.id === gid)) {
      toast('No tienes acceso a ese servidor o el bot ya no está en él.', 'error');
      return navigate('/');
    }
    if (state.guildId !== gid) {
      state.guildId = gid;
      state.meta = null;
      connectEvents();
    }
  } else if (!state.guildId && state.guilds[0]) {
    state.guildId = state.guilds[0].id;
  }
  const params = { guildId: state.guildId };
  (r.keys || []).forEach((k, i) => {
    params[k] = m[i + 2];
  });

  try {
    state.page?.destroy?.();
  } catch {
    /* ignorar */
  }
  disposeCharts();
  hideTip();
  state.page = r.page;
  renderSidebar(r.nav);
  renderTopbar();
  const view = $('#view');
  $('#app').classList.add('is-loading');
  try {
    await r.page.render({ view, params, query, state, navigate, isCurrent: () => seq === routeSeq });
  } catch (err) {
    if (seq !== routeSeq) return undefined;
    view.innerHTML = String(html`<div class="card"><div class="empty"><div class="big">${icon('alert')}</div><h3>No se pudo cargar esta página</h3><p>${err.message}</p><button class="btn" data-act="retry">${icon('refresh')} Reintentar</button></div></div>`);
  } finally {
    if (seq === routeSeq) $('#app').classList.remove('is-loading');
  }
  if (seq === routeSeq) view.focus({ preventScroll: true });
  return undefined;
}

function showLogin(query) {
  state.page?.destroy?.();
  state.page = null;
  disposeCharts();
  closeGuildMenu();
  clearInterval(statusTimer);
  clearTimeout(guildRefreshTimer);
  $('#app').hidden = true;
  const box = $('#login');
  box.hidden = false;
  loginPage.render({ view: box, query, state, onLogin: boot });
}

function closeMobileMenu() {
  $('#app').classList.remove('menu-open');
  $('#scrim').hidden = true;
}

// ─── Acciones globales (delegación) ───────────────────────────────
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'theme') return toggleTheme();
  if (act === 'guildMenu') return openGuildMenu();
  if (act === 'invite') return inviteBot();
  if (act === 'retry') return route();
  if (act === 'logout') {
    await post('/logout').catch(() => {});
    state.session = null;
    state.events?.close();
    location.hash = '#/';
    return boot();
  }
  const handler = state.page?.actions?.[act];
  if (handler) {
    if (el.tagName === 'A' || (el.tagName === 'BUTTON' && el.type === 'submit')) e.preventDefault();
    try {
      await handler(el, e);
    } catch (err) {
      toast(err.message || String(err), 'error');
    }
  }
  return undefined;
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const handler = state.page?.actions?.[el.dataset.change];
  if (handler) Promise.resolve(handler(el, e)).catch((err) => toast(err.message, 'error'));
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  const handler = state.page?.actions?.[el.dataset.input];
  if (handler) Promise.resolve(handler(el, e)).catch((err) => toast(err.message, 'error'));
});
$('#menu-btn').addEventListener('click', () => {
  $('#app').classList.add('menu-open');
  $('#scrim').hidden = false;
});
$('#scrim').addEventListener('click', closeMobileMenu);
window.addEventListener('hashchange', route);

setUnauthorizedHandler(() => {
  if (!state.session) return;
  state.session = null;
  state.events?.close();
  toast('Tu sesión ha caducado. Vuelve a iniciar sesión.', 'info');
  boot();
});

// ─── Arranque ─────────────────────────────────────────────────────
let statusTimer = null;
let bootSeq = 0;
async function boot() {
  const seq = ++bootSeq;
  try {
    const session = await api('/session');
    if (seq !== bootSeq) return;
    state.session = session;
  } catch (err) {
    document.body.innerHTML = `<div class="login"><div class="login-card"><h1>No se pudo conectar</h1><p class="muted">${esc(err.message)}</p><a class="btn primary" href="/">Reintentar</a></div></div>`;
    return;
  }
  if (!state.session.authenticated) {
    clearInterval(statusTimer);
    return route();
  }
  try {
    const guilds = (await get('/guilds')).guilds;
    if (seq !== bootSeq) return;
    state.guilds = guilds;
  } catch {
    state.guilds = [];
  }
  await refreshStatus();
  if (seq !== bootSeq) return;
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 30_000);
  if (!state.guildId && state.guilds[0]) state.guildId = state.guilds[0].id;
  connectEvents();
  return route();
}

boot();
