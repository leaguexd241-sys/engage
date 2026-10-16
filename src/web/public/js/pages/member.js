import { get, post, patch, put, del } from '../api.js';
import { html, icon, num, ago, avatar, toast, modal, confirmDialog, emptyState, ACTIONS, STATUS, METHOD } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let data = null;

const LEVEL_CLS = { elite: 'violet', confiable: 'success', normal: 'warning', riesgo: 'danger' };
const KIND = { like: '❤️ Like', repost: '🔁 Repost', reply: '💬 Comentario', quote: '🗨️ Cita', bonus: '🏆 Bonus', manual: '✍️ Ajuste manual' };

function render() {
  const ctx = ctxRef;
  const { member: m, link, rank, submissions, ledger } = data;
  setTitle(m.displayName || m.username || m.userId, 'Ficha del miembro', { literalTitle: true });
  ctx.view.innerHTML = String(html`
    <div class="row" style="margin-bottom:12px"><a class="btn ghost sm" href="#/g/${state.guildId}/miembros">← Miembros</a></div>
    <div class="card"><div class="card-body row" style="gap:16px;align-items:flex-start">
      ${avatar(m.avatar, m.displayName, 'lg')}
      <div style="flex:1;min-width:220px">
        <h2 style="font-size:20px"><span data-i18n-ignore>${m.displayName || m.username}</span> ${m.blacklisted ? html`<span class="badge danger">${icon('ban')} Bloqueado</span>` : ''}</h2>
        <div class="muted small">${m.username ? `@${m.username} · ` : ''}ID ${m.userId} · visto ${ago(m.lastActiveAt)}</div>
        <div class="row mt" style="gap:8px">
          ${link
            ? html`<a class="badge info" href="https://x.com/${link.handle}" target="_blank" rel="noopener">${icon('xlogo')} @${link.handle}</a>${link.verified ? html`<span class="badge success">${icon('check')} Verificada (${link.method === 'bio' ? 'biografía' : link.method === 'tweet' ? 'post' : 'staff'})</span>` : html`<span class="badge warning">Sin verificar</span>`}`
            : html`<span class="badge">Sin cuenta de X</span>`}
          <span class="badge ${LEVEL_CLS[m.level.key]}">${m.level.emoji} Confianza ${m.trust}/100 · ${m.level.label}</span>
        </div>
      </div>
      <div class="row">
        <button class="btn sm" data-act="points">${icon('star')} Ajustar puntos</button>
        <button class="btn sm" data-act="trust">${icon('shield')} Confianza</button>
        <button class="btn sm" data-act="link">${icon('link')} ${link ? 'Cambiar X' : 'Vincular X'}</button>
        ${link ? html`<button class="btn sm" data-act="unlink">${icon('x')} Desvincular</button>` : ''}
        <button class="btn sm ${m.blacklisted ? '' : 'danger'}" data-act="block">${icon('ban')} ${m.blacklisted ? 'Desbloquear' : 'Bloquear'}</button>
      </div>
    </div></div>

    <div class="grid cols-4 mt">
      <div class="card kpi"><div class="label">🏆 Puntos</div><div class="value">${num(m.points)}</div><div class="foot">${rank ? `Puesto #${rank} del servidor` : 'Sin puesto aún'}</div></div>
      <div class="card kpi"><div class="label">✅ Tareas completadas</div><div class="value">${num(m.completed)}</div><div class="foot">${num(m.missed)} no completadas</div></div>
      <div class="card kpi"><div class="label">🔥 Racha</div><div class="value">${num(m.streak)}</div><div class="foot">Mejor racha: ${num(m.bestStreak)}</div></div>
      <div class="card kpi"><div class="label">🚫 Rechazos</div><div class="value">${num(m.rejected)}</div><div class="foot">Copias, baja calidad, borrados…</div></div>
    </div>

    <div class="grid cols-main mt">
      <div class="card"><div class="card-head"><h2>Participaciones recientes</h2></div><div class="card-body flush" style="margin-top:10px">
        ${submissions.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Tarea</th><th>Acción</th><th>Estado</th><th>Cómo</th><th>Detalle</th><th>Fecha</th></tr></thead><tbody>
              ${submissions.map(
                (s) => html`<tr>
                  <td><a href="#/g/${state.guildId}/tareas/${s.taskId}">#${s.taskId}</a></td>
                  <td>${ACTIONS[s.action].emoji} ${ACTIONS[s.action].label}</td>
                  <td><span class="badge ${STATUS[s.status].cls}">${STATUS[s.status].label}</span></td>
                  <td class="small">${METHOD[s.method] || s.method}</td>
                  <td class="small" style="max-width:260px">${s.quality != null ? html`<span class="muted">calidad ${s.quality}/100</span> ` : ''}${s.reason ? html`<span class="muted ellipsis" title="${s.reason}">${s.reason}</span>` : ''}${s.evidenceUrl && s.evidenceUrl.startsWith('http') ? html` <a href="${s.evidenceUrl}" target="_blank" rel="noopener">${icon('external')}</a>` : ''}</td>
                  <td class="small muted nowrap">${ago(s.updatedAt)}</td>
                </tr>`,
              )}</tbody></table></div>`
          : emptyState('tasks', 'Sin participaciones', 'Este miembro todavía no ha verificado ninguna tarea.')}
      </div></div>
      <div class="stack">
        <div class="card"><div class="card-head"><h2>Movimientos de puntos</h2></div><div class="card-body">
          ${ledger.length
            ? html`<div class="stack" style="gap:8px">${ledger.map(
                (l) => html`<div class="row between small"><span>${KIND[l.kind] || l.kind}${l.task_id ? html` · <a href="#/g/${state.guildId}/tareas/${l.task_id}">#${l.task_id}</a>` : ''}${l.kind === 'manual' && l.reason ? html` <span class="muted">(${l.reason})</span>` : ''}</span><span><strong style="color:var(--${l.amount >= 0 ? 'success' : 'danger'})">${l.amount >= 0 ? '+' : ''}${num(l.amount)}</strong> <span class="muted">${ago(l.created_at)}</span></span></div>`,
              )}</div>`
            : html`<p class="muted small">Sin movimientos.</p>`}
        </div></div>
        <div class="card"><div class="card-head"><h2>Notas del staff</h2></div><div class="card-body">
          <textarea class="input" id="notes" maxlength="1000" placeholder="Notas privadas sobre este miembro (sólo las ve el staff)">${m.notes || ''}</textarea>
          <div class="row mt"><button class="btn sm" data-act="saveNotes">${icon('check')} Guardar notas</button></div>
        </div></div>
      </div>
    </div>`);
}

async function load() {
  const ctx = ctxRef;
  if (!ctx) return;
  const d = await get(`/guilds/${ctx.params.guildId}/members/${ctx.params.uid}`);
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  data = d;
  render();
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    setTitle('Miembro');
    ctx.view.innerHTML = String(html`<div class="skeleton"></div>`);
    await load();
  },
  onLive(ev) {
    if (ev.payload?.userId === ctxRef?.params.uid) load().catch(() => {});
  },
  destroy() {
    ctxRef = null;
    data = null;
  },
  actions: {
    async points() {
      await modal({
        title: 'Ajustar puntos',
        body: html`<div class="form-grid"><div class="field"><label for="amt">Cantidad</label><input class="input" id="amt" name="amount" type="number" required placeholder="Ej.: 10 o -5" /></div>
          <div class="field"><label for="rsn">Motivo</label><input class="input" id="rsn" name="reason" maxlength="200" placeholder="Ej.: ganador del sorteo" /></div></div>`,
        onSubmit: async (f) => {
          await post(`/guilds/${state.guildId}/members/${data.member.userId}/points`, { amount: Number(f.amount.value), reason: f.reason.value || undefined });
          toast('Puntos actualizados.', 'success');
          await load();
        },
      });
    },
    async trust() {
      await modal({
        title: 'Nivel de confianza',
        body: html`<div class="field"><label for="tr">Confianza (0-100)</label><input class="input" id="tr" name="trust" type="number" min="0" max="100" value="${data.member.trust}" required /><span class="hint">Riesgo &lt;30 · Normal 30-59 · Confiable 60-84 · Élite ≥85. Con confianza alta sus capturas se aprueban solas.</span></div>`,
        onSubmit: async (f) => {
          await patch(`/guilds/${state.guildId}/members/${data.member.userId}`, { trust: Number(f.trust.value) });
          toast('Confianza actualizada.', 'success');
          await load();
        },
      });
    },
    async link() {
      await modal({
        title: 'Vincular cuenta de X manualmente',
        body: html`<div class="field"><label for="h">Usuario de X</label><input class="input" id="h" name="handle" placeholder="@usuario" value="${data.link?.handle || ''}" required /></div>
          <label class="check mt"><input type="checkbox" name="verified" checked /> <span>Marcar como verificada (respondes tú por ella). Si otra persona la tenía verificada, se le quitará.</span></label>`,
        onSubmit: async (f) => {
          await put(`/guilds/${state.guildId}/members/${data.member.userId}/link`, { handle: f.handle.value, verified: f.verified.checked });
          toast('Cuenta vinculada.', 'success');
          await load();
        },
      });
    },
    async unlink() {
      if (!(await confirmDialog({ title: 'Desvincular cuenta de X', message: `Se quitará @${data.link.handle} de este miembro. Tendrá que vincularla de nuevo para participar.`, confirmLabel: 'Desvincular', danger: true }))) return;
      await del(`/guilds/${state.guildId}/members/${data.member.userId}/link`);
      toast('Cuenta desvinculada.', 'success');
      await load();
    },
    async block() {
      const block = !data.member.blacklisted;
      if (block && !(await confirmDialog({ title: 'Bloquear miembro', message: 'No podrá participar en las tareas de este servidor ni aparecerá como "falta" en los informes.', confirmLabel: 'Bloquear', danger: true }))) return;
      await patch(`/guilds/${state.guildId}/members/${data.member.userId}`, { blacklisted: block });
      toast(block ? 'Miembro bloqueado.' : 'Miembro desbloqueado.', 'success');
      await load();
    },
    async saveNotes() {
      await patch(`/guilds/${state.guildId}/members/${data.member.userId}`, { notes: document.getElementById('notes').value });
      toast('Notas guardadas.', 'success');
    },
  },
};

