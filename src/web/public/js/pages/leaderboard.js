import { get } from '../api.js';
import { html, icon, num, avatar, emptyState, $ } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let period = 'all';

async function load() {
  const ctx = ctxRef;
  if (!ctx) return;
  const r = await get(`/guilds/${ctx.params.guildId}/leaderboard?period=${period}`);
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  const box = $('#board');
  if (!box) return;
  const items = r.items;
  const max = Math.max(1, ...items.map((i) => i.points));
  box.innerHTML = String(
    items.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th style="width:60px">#</th><th>Miembro</th><th style="width:35%">Puntos</th><th class="num">Completadas</th><th class="num">Racha</th></tr></thead><tbody>
          ${items.map(
            (m, i) => html`<tr class="clickable" data-act="open" data-uid="${m.user_id}">
              <td><span class="rank ${i < 3 ? `r${i + 1}` : ''}">${i + 1}</span></td>
              <td><div class="user-cell">${avatar(m.avatar, m.display_name || m.username, 'sm')}<div class="who"><strong>${m.display_name || m.username || m.user_id}</strong><span>${m.x_handle ? `@${m.x_handle}` : 'sin X'}</span></div></div></td>
              <td><div class="meter-row"><div class="progress"><span style="width:${(m.points / max) * 100}%"></span></div><strong class="nowrap">${num(m.points)}</strong></div></td>
              <td class="num">${num(m.completed || 0)}</td>
              <td class="num">${m.streak ? `🔥 ${m.streak}` : '—'}</td>
            </tr>`,
          )}</tbody></table></div>`
      : emptyState('trophy', 'Sin puntos en este periodo', 'Los puntos se ganan completando tareas. ¡Publica una para empezar!'),
  );
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    period = 'all';
    setTitle('Ranking', 'Los miembros más activos del servidor');
    ctx.view.innerHTML = String(html`
      <div class="toolbar"><div class="seg">
        <button class="active" data-act="period" data-p="all">Siempre</button><button data-act="period" data-p="month">30 días</button><button data-act="period" data-p="week">7 días</button>
      </div><span class="small muted">${icon('info')} Los miembros también lo ven con <code>/ranking</code> en Discord.</span></div>
      <div class="card" id="board"><div class="skeleton" style="border:0"></div></div>`);
    await load();
  },
  onLive(ev) {
    if (ev.kind === 'submission' || ev.kind === 'member') load().catch(() => {});
  },
  destroy() {
    ctxRef = null;
  },
  actions: {
    period(el) {
      period = el.dataset.p;
      el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === el));
      return load();
    },
    open(el) {
      location.hash = `#/g/${state.guildId}/miembros/${el.dataset.uid}`;
    },
  },
};
