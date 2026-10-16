import { get, post, del } from '../api.js';
import { html, icon, num, compact, ago, dateTime, duration, avatar, actionIcons, emptyState, toast, modal, confirmDialog, withBusy, ACTIONS, STATUS, STATE, METHOD, TASK_STATUS, $ } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let data = null;
let filter = 'all';
let search = '';
let liveTimer = null;
let openCell = null;

const STATUS_EMOJI = { verified: '✅', pending: '🕓', awaiting: '📸', rejected: '❌', revoked: '🚫', none: '·' };

function metricsBlock(t) {
  const s = t.metricsStart || {};
  const l = t.metricsLast || s;
  const d = (k) => (Number.isFinite(l[k]) && Number.isFinite(s[k]) ? l[k] - s[k] : null);
  const item = (emoji, label, k) =>
    html`<span title="${label}: ${num(s[k])} al empezar → ${num(l[k])} ahora">${emoji} ${compact(l[k])}${d(k) !== null ? html` <span class="${d(k) > 0 ? 'text-2' : 'muted'}">(${d(k) >= 0 ? '+' : ''}${num(d(k))})</span>` : ''}</span>`;
  return html`<div class="tweet-metrics">${item('❤️', 'Likes', 'likes')}${item('🔁', 'Reposts', 'reposts')}${item('💬', 'Respuestas', 'replies')}${item('🗨️', 'Citas', 'quotes')}${Number.isFinite(l.views) ? html`<span>👁️ ${compact(l.views)}</span>` : ''}</div>`;
}

function header(d) {
  const t = d.task;
  const tw = t.tweet || {};
  const st = TASK_STATUS[t.status];
  const active = t.status === 'active';
  const image = tw.media?.find((m) => m.url)?.url;
  return html`
    <div class="grid cols-main" style="align-items:start">
      <div class="card">
        <div class="card-body">
          <div class="tweet" style="border:0;padding:0">
            <div class="tweet-head">
              ${tw.author?.avatar ? html`<img src="${tw.author.avatar}" alt="" referrerpolicy="no-referrer" />` : html`<span class="avatar">${icon('xlogo')}</span>`}
              <div><strong>${tw.author?.name || '—'}</strong><span>@${tw.author?.handle || '—'} · ${tw.createdAt ? dateTime(tw.createdAt) : ''}</span></div>
              <a class="btn sm" style="margin-left:auto" href="${t.tweetUrl}" target="_blank" rel="noopener">${icon('external')} Ver en X</a>
            </div>
            <div class="tweet-text">${tw.text || ''}</div>
            ${image ? html`<img class="tweet-media" src="${image}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
            ${metricsBlock(t)}
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Tarea #${t.id}</h2><div class="right"><span class="badge ${st.cls}">${st.label}</span></div></div>
        <div class="card-body">
          <dl class="dl">
            <dt>Acciones</dt><dd>${actionIcons(t.actions)}</dd>
            <dt>Creada</dt><dd>${dateTime(t.createdAt)}${t.createdByName ? html` <span class="muted">por ${t.createdByName}</span>` : ''}</dd>
            <dt>${active ? 'Termina' : 'Terminó'}</dt><dd>${dateTime(active ? t.endsAt : t.closedAt || t.endsAt)} <span class="muted">(${active ? ago(t.endsAt) : `duró ${duration((t.closedAt || t.endsAt) - t.createdAt)}`})</span></dd>
            <dt>Puntos</dt><dd>${t.actions.map((a) => `${ACTIONS[a].emoji} ${t.points[a]}`).join(' · ')} · bonus ${t.points.bonus}</dd>
            <dt>Esperados</dt><dd>${t.roleId ? html`Rol <code>${roleName(t.roleId)}</code>` : 'Miembros con X vinculada'}</dd>
            ${t.note ? html`<dt>Nota</dt><dd>${t.note}</dd>` : ''}
            <dt>Discord</dt><dd>${d.messageUrl ? html`<a href="${d.messageUrl}" target="_blank" rel="noopener">Abrir mensaje ${icon('external')}</a>` : html`<span class="muted">sin mensaje</span>`}</dd>
          </dl>
          <div class="row mt">
            ${active
              ? html`
                  <button class="btn sm" data-act="remind">${icon('bell')} Recordar</button>
                  <button class="btn sm" data-act="extend">${icon('clock')} Extender</button>
                  <button class="btn sm primary" data-act="close">${icon('stop')} Cerrar ahora</button>
                  <button class="btn sm" data-act="cancel">${icon('ban')} Cancelar</button>`
              : ''}
            <button class="btn sm" data-act="recheck" title="Comprueba que los comentarios siguen existiendo y actualiza los contadores">${icon('refresh')} Recomprobar</button>
            <a class="btn sm" href="/api/guilds/${t.guildId}/tasks/${t.id}/export.csv" download>${icon('download')} CSV</a>
            <button class="btn sm danger" data-act="remove">${icon('trash')} Eliminar</button>
          </div>
        </div>
      </div>
    </div>`;
}

function roleName(id) {
  return state.meta?.roles?.find((r) => r.id === id)?.name ? `@${state.meta.roles.find((r) => r.id === id).name}` : id;
}

function stats(d) {
  const s = d.stats;
  const t = d.task;
  const base = s.expectedCount ?? s.participants;
  const kpi = (label, value, foot, cls = '', f = null) =>
    html`<div class="card kpi" ${f ? html`data-act="filter" data-f="${f}" style="cursor:pointer"` : ''}><div class="label">${label}</div><div class="value" ${cls ? html`style="color:var(--${cls})"` : ''}>${value}</div><div class="foot">${foot}</div></div>`;
  const flags = t.flags || [];
  return html`
    <div class="grid cols-4 mt">
      ${kpi('✅ Completaron', num(s.completed), base ? `${s.completionRate}% de ${num(base)} ${s.expectedCount != null ? 'esperados' : 'participantes'}` : 'Nadie aún', 'success', 'complete')}
      ${kpi('🕓 En revisión', num(s.pending), 'Esperan al staff o su captura', s.pending ? 'warning' : '', 'pending')}
      ${kpi('⚠️ Incompletas', num(s.partial), 'Hicieron algo pero no todo', s.partial ? 'danger' : '', 'partial')}
      ${kpi('❌ No participaron', s.expectedCount != null ? num(s.missing) : '—', s.expectedCount != null ? 'Esperados sin ninguna acción' : 'Configura un rol de participantes', '', 'none')}
    </div>
    <div class="card mt"><div class="card-body row" style="gap:18px">
      ${t.actions.map((a) => {
        const pa = s.perAction[a] || { verified: 0, pending: 0, rejected: 0, byMethod: {} };
        const methods = Object.entries(pa.byMethod).map(([m, c]) => `${METHOD[m] || m}: ${c}`).join(' · ');
        return html`<div title="${methods}"><div class="small muted">${ACTIONS[a].emoji} ${ACTIONS[a].label}</div><strong>${num(pa.verified)}</strong> <span class="small muted">verificados${pa.pending ? ` · ${pa.pending} en revisión` : ''}${pa.rejected ? ` · ${pa.rejected} rechazados` : ''}</span></div>`;
      })}
      ${s.avgQuality != null ? html`<div><div class="small muted">Calidad media</div><strong>${s.avgQuality}/100</strong></div>` : ''}
    </div></div>
    ${flags.length || t.report?.revoked
      ? html`<div class="alert danger mt">${icon('alert')}<div><strong>Alertas antifraude</strong><div class="small">${flags.map((f) => html`<div>• ${f.message}</div>`)}${t.report?.revoked ? html`<div>• ${t.report.revoked} comentario(s) se borraron después de verificarse y se anularon.</div>` : ''}</div></div></div>`
      : ''}`;
}

function actionCell(row, a) {
  const x = row.actions[a] || { status: 'none' };
  const tip = [STATUS[x.status]?.label, x.method ? METHOD[x.method] : '', x.quality != null ? `calidad ${x.quality}` : '', x.reason || ''].filter(Boolean).join(' · ');
  return html`<button class="act ${x.status}" style="cursor:pointer" title="${tip}" data-act="cell" data-uid="${row.id}" data-a="${a}">${STATUS_EMOJI[x.status]}</button>`;
}

function table(d) {
  const t = d.task;
  const q = search.toLowerCase();
  const rows = d.rows.filter((r) => (filter === 'all' || r.state === filter) && (!q || `${r.name || ''} ${r.xHandle || ''} ${r.id}`.toLowerCase().includes(q)));
  const count = (f) => (f === 'all' ? d.rows.length : d.rows.filter((r) => r.state === f).length);
  const tab = (f, label) => html`<button class="${filter === f ? 'active' : ''}" data-act="filter" data-f="${f}">${label} <span class="muted">${count(f)}</span></button>`;
  return html`
    <div class="card mt">
      <div class="card-head" style="flex-wrap:wrap">
        <h2>Participantes</h2>
        <div class="seg" style="margin-left:8px">${tab('all', 'Todos')}${tab('complete', 'Completaron')}${tab('pending', 'Revisión')}${tab('partial', 'Incompletas')}${tab('none', 'No participaron')}</div>
        <div class="right search">${icon('search')}<input class="input" style="height:32px;width:200px" placeholder="Buscar miembro" value="${search}" data-input="search" aria-label="Buscar participante" /></div>
      </div>
      <div class="card-body flush" style="margin-top:12px">
        ${rows.length
          ? html`<div class="table-wrap"><table class="table">
              <thead><tr><th>Miembro</th><th>Estado</th>${t.actions.map((a) => html`<th title="${ACTIONS[a].label}">${ACTIONS[a].emoji}</th>`)}<th>Comentario</th><th class="num">Puntos</th></tr></thead>
              <tbody>${rows.slice(0, 500).map((r) => {
                const reply = r.actions.reply?.evidenceText ? r.actions.reply : r.actions.quote?.evidenceText ? r.actions.quote : null;
                return html`<tr>
                  <td><div class="user-cell" data-act="member" data-uid="${r.id}" style="cursor:pointer">${avatar(r.avatar, r.name, 'sm')}<div class="who"><strong>${r.name || r.id}</strong><span>${r.xHandle ? `@${r.xHandle}` : 'sin X vinculada'}</span></div></div></td>
                  <td><span class="badge ${STATE[r.state].cls}">${STATE[r.state].label}${r.state !== 'none' ? ` ${r.done}/${r.total}` : ''}</span></td>
                  ${t.actions.map((a) => html`<td>${actionCell(r, a)}</td>`)}
                  <td style="max-width:280px">${reply ? html`<div class="small ellipsis" title="${reply.evidenceText}">${reply.evidenceUrl ? html`<a href="${reply.evidenceUrl}" target="_blank" rel="noopener">${reply.evidenceText}</a>` : reply.evidenceText}</div><div class="small muted">${reply.quality != null ? `calidad ${reply.quality}/100` : ''}</div>` : html`<span class="muted small">—</span>`}</td>
                  <td class="num">${num(r.points)}</td>
                </tr>`;
              })}</tbody></table></div>
              ${rows.length > 500 ? html`<p class="small muted" style="padding:10px 18px">Mostrando 500 de ${num(rows.length)}. Descarga el CSV para verlos todos.</p>` : ''}`
          : emptyState('users', 'Nadie en esta lista', filter === 'none' ? '¡Todos los esperados participaron!' : 'Cuando los miembros verifiquen sus acciones aparecerán aquí.')}
      </div>
    </div>`;
}

function renderAll() {
  const ctx = ctxRef;
  if (!ctx || !data) return;
  setTitle(`Tarea #${data.task.id}`, `@${data.task.tweet?.author?.handle || ''} · ${TASK_STATUS[data.task.status].label}`);
  ctx.view.innerHTML = String(html`<div class="row" style="margin-bottom:12px"><a class="btn ghost sm" href="#/g/${data.task.guildId}/tareas">← Tareas</a></div>${header(data)}${stats(data)}<div id="ptable">${table(data)}</div>`);
}

async function load() {
  const ctx = ctxRef;
  if (!ctx) return;
  const d = await get(`/guilds/${ctx.params.guildId}/tasks/${ctx.params.id}`);
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  data = d;
  renderAll();
}

async function op(name, body, msg) {
  const r = await post(`/guilds/${state.guildId}/tasks/${data.task.id}/${name}`, body);
  if (msg) toast(typeof msg === 'function' ? msg(r) : msg, 'success');
  await load();
  return r;
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    data = null;
    filter = ctx.query.f || 'all';
    search = '';
    setTitle(`Tarea #${ctx.params.id}`);
    ctx.view.innerHTML = String(html`<div class="skeleton" style="min-height:260px"></div><div class="skeleton mt" style="min-height:300px"></div>`);
    const { loadMeta } = await import('../main.js');
    await loadMeta().catch(() => null);
    await load();
  },
  onLive(ev) {
    if (!data || (ev.payload?.taskId && ev.payload.taskId !== data.task.id)) return;
    if (ev.payload?.deleted) {
      toast('Esta tarea fue eliminada.', 'info');
      location.hash = `#/g/${state.guildId}/tareas`;
      return;
    }
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => load().catch(() => {}), 700);
  },
  destroy() {
    clearTimeout(liveTimer);
    ctxRef = null;
    data = null;
  },
  actions: {
    filter(el) {
      filter = el.dataset.f;
      $('#ptable').innerHTML = String(table(data));
    },
    search(el) {
      search = el.value;
      const pos = el.selectionStart;
      $('#ptable').innerHTML = String(table(data));
      const input = $('#ptable input[data-input=search]');
      input.focus();
      input.setSelectionRange(pos, pos);
    },
    member(el) {
      location.hash = `#/g/${state.guildId}/miembros/${el.dataset.uid}`;
    },
    remind(el) {
      return withBusy(el, () => op('remind', {}, (r) => (r.targets ? `Recordatorio enviado a ${r.targets} miembros.` : 'Nadie tiene la tarea pendiente.')));
    },
    async extend() {
      await modal({
        title: 'Extender la tarea',
        body: html`<div class="field"><label for="ext">¿Cuánto tiempo más?</label><select class="input" id="ext" name="d"><option value="15m">15 minutos</option><option value="30m" selected>30 minutos</option><option value="1h">1 hora</option><option value="3h">3 horas</option><option value="1d">1 día</option></select></div>`,
        submitLabel: 'Extender',
        onSubmit: (form) => op('extend', { duration: form.d.value }, 'Tarea extendida.'),
      });
    },
    async close() {
      if (!(await confirmDialog({ title: 'Cerrar la tarea ahora', message: 'Se recomprobarán los comentarios, se publicará el informe de quién hizo y quién no en Discord y ya nadie podrá verificar.', confirmLabel: 'Cerrar tarea' }))) return;
      await op('close', {}, 'Tarea cerrada. Informe publicado.');
    },
    async cancel() {
      if (!(await confirmDialog({ title: 'Cancelar la tarea', message: 'La tarea se detiene sin informe final. Los puntos ya ganados se mantienen.', confirmLabel: 'Cancelar tarea', danger: true }))) return;
      await op('cancel', {}, 'Tarea cancelada.');
    },
    recheck(el) {
      return withBusy(el, () => op('recheck', {}, (r) => (r.revoked ? `${r.revoked} comentario(s) borrado(s) anulados.` : 'Todo en orden: ningún comentario fue borrado.')));
    },
    async remove() {
      if (!(await confirmDialog({ title: `Eliminar la tarea #${data.task.id}`, message: 'Se borrará la tarea, su mensaje de Discord, las participaciones y los puntos que otorgó. No se puede deshacer.', confirmLabel: 'Eliminar definitivamente', danger: true }))) return;
      await del(`/guilds/${state.guildId}/tasks/${data.task.id}`);
      toast('Tarea eliminada.', 'success');
      location.hash = `#/g/${state.guildId}/tareas`;
    },
    async cell(el) {
      const r = data.rows.find((x) => x.id === el.dataset.uid);
      const a = el.dataset.a;
      const x = r?.actions[a] || { status: 'none' };
      openCell = { uid: el.dataset.uid, a };
      const proof = x.evidenceUrl?.startsWith('proof:') ? `/api/proofs/${x.evidenceUrl.slice(6)}` : null;
      const choice = await modal({
        title: `${ACTIONS[a].emoji} ${ACTIONS[a].label} · ${r?.name || el.dataset.uid}`,
        body: html`
          <dl class="dl">
            <dt>Estado</dt><dd><span class="badge ${STATUS[x.status].cls}">${STATUS[x.status].label}</span></dd>
            ${x.method ? html`<dt>Cómo</dt><dd>${METHOD[x.method] || x.method}</dd>` : ''}
            ${x.quality != null ? html`<dt>Calidad</dt><dd>${x.quality}/100</dd>` : ''}
            ${x.reason ? html`<dt>Motivo</dt><dd>${x.reason}</dd>` : ''}
            ${x.updatedAt ? html`<dt>Fecha</dt><dd>${dateTime(x.updatedAt)}</dd>` : ''}
            ${x.evidenceText ? html`<dt>Texto</dt><dd><div class="quote">${x.evidenceText}</div></dd>` : ''}
            ${x.evidenceUrl && !proof ? html`<dt>Enlace</dt><dd><a href="${x.evidenceUrl}" target="_blank" rel="noopener">${x.evidenceUrl}</a></dd>` : ''}
          </dl>
          ${proof ? html`<a href="${proof}" target="_blank" rel="noopener"><img class="proof-img mt" src="${proof}" alt="Captura enviada" /></a>` : ''}
          <p class="small muted mt">Como staff puedes corregir el resultado manualmente. Los puntos y el estado del miembro se recalculan solos.</p>
          <div class="row"><button type="button" class="btn success sm" data-mark="1">${icon('check')} Marcar como hecho</button><button type="button" class="btn danger sm" data-mark="0">${icon('x')} Marcar como no hecho</button></div>`,
        hideSubmit: true,
        cancelLabel: 'Cerrar',
        onSubmit: null,
      }).catch(() => null);
      openCell = null;
      return choice;
    },
  },
};

// Botones "marcar" dentro del diálogo de una celda (la celda abierta se guarda en openCell).
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-mark]');
  if (!b || !data || !ctxRef || !openCell) return;
  const cell = openCell;
  await withBusy(b, async () => {
    try {
      await post(`/guilds/${state.guildId}/tasks/${data.task.id}/manual`, { userId: cell.uid, action: cell.a, done: b.dataset.mark === '1' });
      toast('Actualizado.', 'success');
      b.closest('.modal-back')?.querySelector('[data-close]')?.click();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});
