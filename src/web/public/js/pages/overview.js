import { get } from '../api.js';
import { html, icon, num, ago, avatar, actionIcons, withMentions, mountColumnChart, disposeCharts, emptyState, raw, esc, showTip, hideTip, $, $$ } from '../ui.js';
import { setTitle, state } from '../main.js';

const FEED_ICON = { task: 'tasks', complete: 'check', reject: 'x', link: 'link', review: 'shield', proof: 'image', fraud: 'alert', reminder: 'bell', settings: 'settings', points: 'star', member: 'user' };
const FEED_CLS = { complete: 'success', reject: 'danger', fraud: 'danger', review: 'violet', proof: 'warning', reminder: 'warning' };
const METHOD_ORDER = [
  ['auto', 'Comprobado en X'],
  ['timeline', 'Visto en perfil'],
  ['declared', 'Declarado'],
  ['screenshot', 'Captura'],
  ['manual', 'Staff'],
];
const ACTION_ROWS = [
  ['like', '❤️ Likes'],
  ['repost', '🔁 Reposts'],
  ['reply', '💬 Comentarios'],
  ['quote', '🗨️ Citas'],
];

let ctxRef = null;
let timer = null;
let users = {};

export function feedItem(a, userMap = {}, fresh = false) {
  return html`<div class="feed-item ${fresh ? 'new' : ''}">
    <span class="ic ${FEED_CLS[a.type] || ''}">${icon(FEED_ICON[a.type] || 'info')}</span>
    <div class="txt">${withMentions(a.message, userMap)}${a.actorName ? html` <span class="muted small">· ${a.actorName}</span>` : ''}</div>
    <span class="when" title="${new Date(a.createdAt).toLocaleString('es-ES')}">${ago(a.createdAt)}</span>
  </div>`;
}

function kpi(label, value, foot, ic, cls = '') {
  return html`<div class="card kpi"><div class="label"><span class="ic ${cls}">${icon(ic)}</span>${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
}

function breakdown(rows) {
  const by = {};
  for (const r of rows) {
    by[r.action] = by[r.action] || {};
    by[r.action][r.method] = r.c;
  }
  const max = Math.max(1, ...ACTION_ROWS.map(([a]) => Object.values(by[a] || {}).reduce((s, v) => s + v, 0)));
  const legend = html`<div class="legend">${METHOD_ORDER.map(([, label], i) => html`<span><span class="sw" style="background:var(--series-${i + 1})"></span>${label}</span>`)}</div>`;
  const bars = ACTION_ROWS.map(([a, label]) => {
    const vals = by[a] || {};
    const total = Object.values(vals).reduce((s, v) => s + v, 0);
    const segs = METHOD_ORDER.map(([m, mlabel], i) =>
      vals[m] ? html`<span data-tip="${num(vals[m])}|${label.slice(3)} · ${mlabel}" style="width:${(vals[m] / max) * 100}%;background:var(--series-${i + 1})"></span>` : '',
    );
    return html`<div class="breakdown-row"><span class="small text-2">${label}</span><div class="stackbar" style="background:transparent">${segs}</div><span class="num small"><strong>${num(total)}</strong></span></div>`;
  });
  const table = html`<details class="mt"><summary class="small muted" style="cursor:pointer">Ver como tabla</summary>
    <div class="table-wrap mt"><table class="table"><thead><tr><th>Acción</th>${METHOD_ORDER.map(([, l]) => html`<th class="num">${l}</th>`)}</tr></thead>
    <tbody>${ACTION_ROWS.map(([a, label]) => html`<tr><td>${label}</td>${METHOD_ORDER.map(([m]) => html`<td class="num">${num(by[a]?.[m] || 0)}</td>`)}</tr>`)}</tbody></table></div></details>`;
  return html`${legend}${bars}${table}`;
}

async function load(ctx) {
  const gid = ctx.params.guildId;
  const data = await get(`/guilds/${gid}/overview`);
  if (!ctx.isCurrent()) return;
  const g = state.guilds.find((x) => x.id === gid);
  setTitle('Resumen', g ? g.name : '');
  const c = data.counts;
  const texts = data.recent.map((r) => r.message);
  users = {};
  if (texts.length) {
    try {
      users = (await ctx.post(`/guilds/${gid}/mentions`, { texts })).users;
    } catch {
      users = {};
    }
  }
  const totalWeek = data.daily.slice(-7).reduce((s, d) => s + d.verified, 0);
  const dayFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
  const daily = data.daily.map((d) => {
    const date = new Date(`${d.day}T12:00:00`);
    return {
      label: dayFmt.format(date).replace('.', ''),
      value: d.verified,
      tip: html`<div class="tv">${num(d.verified)}</div><div class="tl">acciones verificadas</div><div class="small muted">${new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(date)}</div><div class="small">${num(d.users)} miembros · ${num(d.rejected)} rechazos</div>`,
    };
  });
  const rates = data.recentClosed.map((t) => ({
    label: `#${t.id}`,
    value: t.completionRate,
    tip: html`<div class="tv">${t.completionRate}%</div><div class="tl">participación en #${t.id}</div><div class="small muted">${num(t.completed)} completaron${t.handle ? ` · @${t.handle}` : ''}</div>`,
  }));

  disposeCharts();
  ctx.view.innerHTML = String(html`
    <div class="grid cols-4">
      ${kpi('Tareas activas', num(c.active_tasks), `${num(c.total_tasks)} en total`, 'tasks')}
      ${kpi('Acciones verificadas', num(c.verified), `${num(totalWeek)} en los últimos 7 días`, 'check', 'success')}
      ${kpi('Miembros con X vinculada', num(c.linked), `de ${num(c.members)} que usaron el bot`, 'link', 'violet')}
      ${kpi('Pendientes de revisión', num(c.pending), c.avg_quality != null ? `Calidad media de comentarios: ${c.avg_quality}/100` : 'Sin comentarios aún', 'shield', c.pending ? 'warning' : '')}
    </div>

    <div class="grid cols-main mt">
      <div class="card">
        <div class="card-head"><div><h2>Acciones verificadas por día</h2><div class="sub">Últimos 14 días</div></div></div>
        <div class="card-body"><div id="chart-daily"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Cómo se verificó cada acción</h2><div class="sub">Total histórico</div></div></div>
        <div class="card-body" id="breakdown">${breakdown(data.breakdown)}</div>
      </div>
    </div>

    <div class="grid cols-main mt">
      <div class="card">
        <div class="card-head"><h2>Tareas activas</h2><div class="right"><a class="btn sm" href="#/g/${gid}/tareas">Ver todas</a></div></div>
        <div class="card-body flush" style="margin-top:12px">
          ${data.active.length
            ? data.active.map((t) => {
                const base = t.expected ?? t.participants;
                const pctv = base ? Math.round((t.completed / base) * 100) : 0;
                return html`<div class="task-card" data-act="openTask" data-id="${t.id}">
                  ${t.tweet?.author?.avatar ? html`<img class="thumb" src="${t.tweet.author.avatar}" alt="" referrerpolicy="no-referrer" />` : html`<span class="thumb"></span>`}
                  <div style="min-width:0">
                    <div class="title">#${t.id} · @${t.tweet?.author?.handle || '—'} ${actionIcons(t.actions)}</div>
                    <div class="text">${t.tweet?.text || ''}</div>
                    <div class="meta"><span>${icon('clock')} termina ${ago(t.endsAt)}</span></div>
                  </div>
                  <div class="side">
                    <div class="small"><strong>${num(t.completed)}</strong>${base ? ` / ${num(base)}` : ''} completaron</div>
                    <div class="meter-row mt" style="margin-top:6px"><div class="progress success"><span style="width:${pctv}%"></span></div><span class="small muted">${pctv}%</span></div>
                  </div>
                </div>`;
              })
            : emptyState('tasks', 'No hay tareas activas', 'Crea una tarea para que tus miembros interactúen con un post de X.', html`<a class="btn primary" href="#/g/${gid}/tareas/nueva">${icon('plus')} Nueva tarea</a>`)}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Top 30 días</h2><div class="right"><a class="btn sm" href="#/g/${gid}/ranking">Ranking</a></div></div>
        <div class="card-body">
          ${data.top.length
            ? html`<div class="stack" style="gap:10px">${data.top.map(
                (r, i) => html`<div class="user-cell" data-act="openMember" data-uid="${r.user_id}" style="cursor:pointer">
                  <span class="rank ${i < 3 ? `r${i + 1}` : ''}">${i + 1}</span>
                  ${avatar(r.avatar, r.display_name || r.username, 'sm')}
                  <div class="who" style="flex:1"><strong>${r.display_name || r.username || r.user_id}</strong><span>${r.x_handle ? `@${r.x_handle}` : 'sin X'}</span></div>
                  <strong>${num(r.points)} pts</strong>
                </div>`,
              )}</div>`
            : html`<p class="muted small">Todavía no hay puntos este mes.</p>`}
        </div>
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <div class="card-head"><div><h2>Participación en las últimas tareas</h2><div class="sub">% de miembros esperados que completaron cada tarea</div></div></div>
        <div class="card-body">${rates.length ? html`<div id="chart-rates"></div>` : html`<p class="muted small">Aparecerá cuando termine la primera tarea.</p>`}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Actividad reciente</h2><div class="right"><span class="badge success" title="Actualización en vivo"><span class="dot"></span>En vivo</span><a class="btn sm" href="#/g/${gid}/actividad">Ver todo</a></div></div>
        <div class="card-body flush" style="margin-top:10px"><div class="feed" id="feed">${data.recent.length ? data.recent.map((a) => feedItem(a, users)) : html`<p class="muted small" style="padding:0 18px 16px">Sin actividad todavía.</p>`}</div></div>
      </div>
    </div>`);

  mountColumnChart($('#chart-daily', ctx.view), daily, { height: 220 });
  if (rates.length) mountColumnChart($('#chart-rates', ctx.view), rates, { height: 200, unit: '%', maxValue: 100, valueLabel: (v) => Math.round(v) });
  for (const seg of $$('#breakdown [data-tip]', ctx.view)) {
    seg.addEventListener('pointermove', (e) => {
      const [v, l] = seg.dataset.tip.split('|');
      showTip(e, raw(`<div class="tv">${esc(v)}</div><div class="tl">${esc(l)}</div>`));
    });
    seg.addEventListener('pointerleave', hideTip);
  }
}

export default {
  async render(ctx) {
    ctxRef = { ...ctx, post: (await import('../api.js')).post };
    setTitle('Resumen');
    ctx.view.innerHTML = String(html`<div class="grid cols-4">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="min-height:110px"></div>`)}</div><div class="skeleton mt" style="min-height:300px"></div>`);
    await load(ctxRef);
  },
  onLive() {
    clearTimeout(timer);
    timer = setTimeout(() => ctxRef && load(ctxRef).catch(() => {}), 1200);
  },
  onAudit(entry) {
    const feed = document.getElementById('feed');
    if (!feed) return;
    feed.insertAdjacentHTML('afterbegin', String(feedItem(entry, users, true)));
    while (feed.children.length > 12) feed.lastElementChild.remove();
  },
  onTheme() {},
  destroy() {
    clearTimeout(timer);
    ctxRef = null;
  },
  actions: {
    openTask(el) {
      location.hash = `#/g/${state.guildId}/tareas/${el.dataset.id}`;
    },
    openMember(el) {
      location.hash = `#/g/${state.guildId}/miembros/${el.dataset.uid}`;
    },
  },
};
