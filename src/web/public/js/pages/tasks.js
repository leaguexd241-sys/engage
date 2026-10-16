import { get } from '../api.js';
import { html, icon, num, ago, dateTime, actionIcons, emptyState, TASK_STATUS, $ } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let filters = { status: '', search: '', page: 1 };
let searchTimer = null;
let liveTimer = null;

function row(t, gid) {
  const st = TASK_STATUS[t.status];
  const base = t.expected ?? t.participants;
  const pct = t.completionRate ?? (base ? Math.round((t.completed / base) * 100) : 0);
  const media = t.tweet?.media?.[0]?.url || t.tweet?.author?.avatar;
  return html`<div class="task-card" data-act="open" data-id="${t.id}">
    ${media ? html`<img class="thumb" src="${media}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : html`<span class="thumb"></span>`}
    <div style="min-width:0">
      <div class="title"><span>#${t.id}</span><span class="badge ${st.cls}">${st.label}</span>${actionIcons(t.actions)}${t.pending ? html`<span class="badge warning">${icon('shield')} ${t.pending} en revisión</span>` : ''}${t.flags ? html`<span class="badge danger" title="Alertas antifraude">${icon('alert')} ${t.flags}</span>` : ''}</div>
      <div class="text">@${t.tweet?.author?.handle || '—'} · ${t.tweet?.text || ''}</div>
      <div class="meta">
        <span title="${dateTime(t.createdAt)}">Creada ${ago(t.createdAt)}${t.createdByName ? ` por ${t.createdByName}` : ''}</span>
        <span>${t.status === 'active' ? html`${icon('clock')} termina ${ago(t.endsAt)}` : `terminó ${ago(t.closedAt || t.endsAt)}`}</span>
      </div>
    </div>
    <div class="side">
      <div class="small"><strong>${num(t.completed)}</strong>${t.expected != null ? ` / ${num(t.expected)}` : ''} completaron</div>
      <div class="small muted">${num(t.participants)} participaron</div>
      <div class="meter-row" style="margin-top:6px"><div class="progress success"><span style="width:${Math.min(100, pct)}%"></span></div><span class="small muted">${pct}%</span></div>
    </div>
  </div>`;
}

async function load() {
  const ctx = ctxRef;
  if (!ctx) return;
  const gid = ctx.params.guildId;
  const q = new URLSearchParams({ page: filters.page });
  if (filters.status) q.set('status', filters.status);
  if (filters.search) q.set('search', filters.search);
  const data = await get(`/guilds/${gid}/tasks?${q}`);
  if (!ctx.isCurrent()) return;
  const list = $('#task-list', ctx.view);
  if (!list) return;
  list.innerHTML = String(
    data.items.length
      ? html`${data.items.map((t) => row(t, gid))}
          <div class="pager"><span>${num(data.total)} tareas · página ${data.page} de ${data.pages}</span>
            <span class="row"><button class="btn sm" data-act="page" data-dir="-1" ${data.page <= 1 ? 'disabled' : ''}>Anterior</button><button class="btn sm" data-act="page" data-dir="1" ${data.page >= data.pages ? 'disabled' : ''}>Siguiente</button></span>
          </div>`
      : emptyState(
          'tasks',
          filters.search || filters.status ? 'No hay tareas con esos filtros' : 'Aún no hay tareas',
          filters.search || filters.status ? 'Prueba a cambiar los filtros.' : 'Publica tu primera tarea: pega el enlace de un post de X y elige qué acciones pedir.',
          html`<a class="btn primary" href="#/g/${gid}/tareas/nueva">${icon('plus')} Nueva tarea</a>`,
        ),
  );
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    filters = { status: ctx.query.status || '', search: '', page: 1 };
    setTitle('Tareas', 'Publicaciones de X que tus miembros deben apoyar');
    const seg = (v, l) => html`<button class="${filters.status === v ? 'active' : ''}" data-act="status" data-v="${v}">${l}</button>`;
    ctx.view.innerHTML = String(html`
      <div class="toolbar">
        <div class="seg" role="tablist">${seg('', 'Todas')}${seg('active', 'Activas')}${seg('closed', 'Finalizadas')}${seg('cancelled', 'Canceladas')}</div>
        <div class="search">${icon('search')}<input class="input" placeholder="Buscar por #, texto o @usuario" data-input="search" aria-label="Buscar tareas" /></div>
        <a class="btn primary" style="margin-left:auto" href="#/g/${ctx.params.guildId}/tareas/nueva">${icon('plus')} Nueva tarea</a>
      </div>
      <div class="card" id="task-list"><div class="skeleton" style="border:0"></div></div>`);
    await load();
  },
  onLive(ev) {
    if (ev.kind !== 'task' && ev.kind !== 'submission') return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => load().catch(() => {}), 900);
  },
  destroy() {
    clearTimeout(searchTimer);
    clearTimeout(liveTimer);
    ctxRef = null;
  },
  actions: {
    open(el) {
      location.hash = `#/g/${state.guildId}/tareas/${el.dataset.id}`;
    },
    status(el) {
      filters.status = el.dataset.v;
      filters.page = 1;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === el));
      return load();
    },
    search(el) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        filters.search = el.value.trim();
        filters.page = 1;
        load();
      }, 300);
    },
    page(el) {
      filters.page = Math.max(1, filters.page + Number(el.dataset.dir));
      return load();
    },
  },
};
