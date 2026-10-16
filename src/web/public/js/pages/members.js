import { get } from '../api.js';
import { html, icon, num, ago, avatar, emptyState, $ } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let q = { search: '', sort: 'points', page: 1 };
let searchTimer = null;
let liveTimer = null;

const LEVEL_CLS = { elite: 'violet', confiable: 'success', normal: 'warning', riesgo: 'danger' };

async function load() {
  const ctx = ctxRef;
  if (!ctx) return;
  const params = new URLSearchParams({ page: q.page, sort: q.sort });
  if (q.search) params.set('search', q.search);
  const data = await get(`/guilds/${ctx.params.guildId}/members?${params}`);
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  const box = $('#members');
  if (!box) return;
  box.innerHTML = String(
    data.items.length
      ? html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Miembro</th><th>Cuenta de X</th><th class="num">Puntos</th><th>Confianza</th><th class="num">Completadas</th><th class="num">No hechas</th><th class="num">Racha</th><th>Última actividad</th></tr></thead>
          <tbody>${data.items.map(
            (m) => html`<tr class="clickable" data-act="open" data-uid="${m.userId}">
              <td><div class="user-cell">${avatar(m.avatar, m.displayName, 'sm')}<div class="who"><strong>${m.displayName || m.username || m.userId}</strong><span>${m.username ? `@${m.username}` : m.userId}</span></div>${m.blacklisted ? html`<span class="badge danger" title="Bloqueado">${icon('ban')}</span>` : ''}</div></td>
              <td>${m.xHandle ? html`<a href="https://x.com/${m.xHandle}" target="_blank" rel="noopener" data-stop>@${m.xHandle}</a> ${m.xVerified ? html`<span class="badge success" title="Verificada">${icon('check')}</span>` : html`<span class="badge warning" title="Sin verificar">!</span>`}` : html`<span class="muted">—</span>`}</td>
              <td class="num"><strong>${num(m.points)}</strong></td>
              <td><span class="badge ${LEVEL_CLS[m.level.key]}">${m.level.emoji} ${m.trust}</span></td>
              <td class="num">${num(m.completed)}</td>
              <td class="num">${num(m.missed)}</td>
              <td class="num">${m.streak ? `🔥 ${m.streak}` : '—'}</td>
              <td class="muted small">${ago(m.lastActiveAt)}</td>
            </tr>`,
          )}</tbody></table></div>
          <div class="pager"><span>${num(data.total)} miembros · página ${data.page} de ${data.pages}</span><span class="row"><button class="btn sm" data-act="page" data-dir="-1" ${data.page <= 1 ? 'disabled' : ''}>Anterior</button><button class="btn sm" data-act="page" data-dir="1" ${data.page >= data.pages ? 'disabled' : ''}>Siguiente</button></span></div>`
      : emptyState('users', q.search ? 'Nadie coincide con la búsqueda' : 'Aún no hay miembros', q.search ? 'Prueba con otro nombre o @ de X.' : 'Los miembros aparecen aquí cuando usan el bot por primera vez (por ejemplo, al vincular su cuenta de X).'),
  );
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    q = { search: '', sort: 'points', page: 1 };
    setTitle('Miembros', 'Cuentas vinculadas, puntos y nivel de confianza');
    ctx.view.innerHTML = String(html`
      <div class="toolbar">
        <div class="search">${icon('search')}<input class="input" placeholder="Buscar por nombre, @ de X o ID" data-input="search" aria-label="Buscar miembros" /></div>
        <label class="row small muted" style="gap:8px">Ordenar por
          <select class="input" style="width:auto;height:34px" data-change="sort">
            <option value="points">Puntos</option><option value="trust">Confianza</option><option value="completed">Completadas</option><option value="missed">No hechas</option><option value="streak">Racha</option><option value="recent">Actividad reciente</option><option value="name">Nombre</option>
          </select></label>
      </div>
      <div class="alert info small" style="margin-bottom:16px">${icon('info')}<span><strong>Confianza</strong> (0-100): sube con acciones comprobadas y baja con rechazos, copias o comentarios borrados. Con confianza alta, las capturas se aprueban solas (umbral en Ajustes).</span></div>
      <div class="card" id="members"><div class="skeleton" style="border:0"></div></div>`);
    await load();
  },
  onLive(ev) {
    if (!['member', 'submission'].includes(ev.kind)) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => load().catch(() => {}), 1000);
  },
  destroy() {
    clearTimeout(searchTimer);
    clearTimeout(liveTimer);
    ctxRef = null;
  },
  actions: {
    open(el, e) {
      if (e.target.closest('[data-stop]')) return;
      location.hash = `#/g/${state.guildId}/miembros/${el.dataset.uid}`;
    },
    search(el) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        q.search = el.value.trim();
        q.page = 1;
        load();
      }, 300);
    },
    sort(el) {
      q.sort = el.value;
      q.page = 1;
      return load();
    },
    page(el) {
      q.page = Math.max(1, q.page + Number(el.dataset.dir));
      return load();
    },
  },
};
