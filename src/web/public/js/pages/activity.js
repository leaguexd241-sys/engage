import { get, post } from '../api.js';
import { html, emptyState, $ } from '../ui.js';
import { setTitle, state } from '../main.js';
import { feedItem } from './overview.js';

let ctxRef = null;
let items = [];
let users = {};
let type = '';
let done = false;

const TYPES = [
  ['', 'Todo'],
  ['task', 'Tareas'],
  ['complete', 'Completadas'],
  ['reject', 'Rechazos'],
  ['review', 'Revisiones'],
  ['proof', 'Capturas'],
  ['fraud', 'Antifraude'],
  ['link', 'Vinculaciones'],
  ['reminder', 'Recordatorios'],
  ['points', 'Puntos'],
  ['settings', 'Ajustes'],
];

function renderList() {
  const box = $('#activity');
  if (!box) return;
  box.innerHTML = String(
    items.length
      ? html`<div class="feed">${items.map((a) => feedItem(a, users))}</div>${done ? '' : html`<div class="pager" style="justify-content:center"><button class="btn sm" data-act="more">Cargar más</button></div>`}`
      : emptyState('activity', 'Sin actividad', 'Aquí verás en tiempo real todo lo que pasa: tareas, verificaciones, rechazos, revisiones y alertas antifraude.'),
  );
}

async function load(append = false) {
  const ctx = ctxRef;
  if (!ctx) return;
  const q = new URLSearchParams();
  if (type) q.set('type', type);
  if (append && items.length) q.set('before', items[items.length - 1].id);
  const r = await get(`/guilds/${ctx.params.guildId}/activity?${q}`);
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  items = append ? [...items, ...r.items] : r.items;
  users = { ...users, ...r.users };
  done = r.items.length < 50;
  renderList();
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    items = [];
    users = {};
    type = '';
    setTitle('Actividad', 'Registro de todo lo que hace el bot (se guarda 90 días)');
    ctx.view.innerHTML = String(html`
      <div class="toolbar"><label class="row small muted" style="gap:8px">Mostrar
        <select class="input" style="width:auto;height:34px" data-change="type">${TYPES.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></label>
        <span class="badge success" style="margin-left:auto"><span class="dot"></span> En vivo</span></div>
      <div class="card" id="activity"><div class="skeleton" style="border:0"></div></div>`);
    await load();
  },
  async onAudit(entry) {
    if (type && entry.type !== type) return;
    const ids = [...String(entry.message).matchAll(/<@!?(\d{5,25})>/g)].map((m) => m[1]).filter((id) => !(id in users));
    if (ids.length) {
      try {
        users = { ...users, ...(await post(`/guilds/${state.guildId}/mentions`, { texts: [entry.message] })).users };
      } catch {
        /* se muestran como @usuario */
      }
    }
    items = [entry, ...items].slice(0, 500);
    const feed = document.querySelector('#activity .feed');
    if (feed) feed.insertAdjacentHTML('afterbegin', String(feedItem(entry, users, true)));
    else renderList();
  },
  destroy() {
    ctxRef = null;
  },
  actions: {
    type(el) {
      type = el.value;
      return load();
    },
    more() {
      return load(true);
    },
  },
};
