import { get, post } from '../api.js';
import { html, icon, ago, avatar, emptyState, toast, modal, withBusy, ACTIONS, $ } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let items = [];
let liveTimer = null;

function card(s) {
  const a = ACTIONS[s.action];
  return html`<div class="card" data-sid="${s.id}">
    <div class="card-body">
      <div class="row between">
        <div class="user-cell" data-act="member" data-uid="${s.userId}" style="cursor:pointer">${avatar(s.user?.avatar, s.user?.name, 'sm')}<div class="who"><strong>${s.user?.name || s.userId}</strong><span>${s.user?.xHandle ? `@${s.user.xHandle}` : 'sin X'} · confianza ${s.user?.trust ?? '—'}/100</span></div></div>
        <span class="badge warning">${a.emoji} ${a.label}</span>
      </div>
      <dl class="dl mt">
        <dt>Tarea</dt><dd><a href="#/g/${state.guildId}/tareas/${s.taskId}">#${s.taskId}</a> · <a href="${s.tweetUrl}" target="_blank" rel="noopener">ver post ${icon('external')}</a>${s.taskStatus !== 'active' ? html` <span class="badge">finalizada</span>` : ''}</dd>
        <dt>Prueba</dt><dd>${s.method === 'auto' ? 'Post comprobado en X' : s.method === 'screenshot' ? 'Captura de pantalla' : 'Declaración sin captura'}</dd>
        <dt>Enviado</dt><dd>${ago(s.updatedAt)}</dd>
      </dl>
      ${s.method === 'auto' ? html`<div class="alert info small mt">${icon('info')}<span>Calidad orientativa: ${s.quality}/100. El staff decide si el comentario es válido.</span></div><blockquote data-i18n-ignore>${s.evidenceText || ''}</blockquote><a href="${s.evidenceUrl}" target="_blank" rel="noopener">Ver comentario en X ${icon('external')}</a>` : s.proofUrl ? html`<a href="${s.proofUrl}" target="_blank" rel="noopener"><img class="proof-img mt" src="${s.proofUrl}" alt="Captura enviada por el miembro" loading="lazy" /></a>` : html`<div class="alert warning small mt">${icon('info')}<span>Sin captura: el miembro declaró haberlo hecho. Compara con el contador de ${a.label.toLowerCase()}s del post.</span></div>`}
      <div class="row mt">
        <button class="btn success sm" data-act="approve" data-sid="${s.id}">${icon('check')} Aprobar</button>
        <button class="btn danger sm" data-act="reject" data-sid="${s.id}">${icon('x')} Rechazar</button>
      </div>
    </div>
  </div>`;
}

function renderList() {
  const box = $('#reviews');
  if (!box) return;
  setTitle('Revisión', items.length ? `${items.length} pendiente${items.length === 1 ? '' : 's'}` : 'Todo al día');
  box.innerHTML = String(
    items.length
      ? html`<div class="row" style="margin-bottom:14px"><span class="muted small">Las capturas se guardan 45 días. El miembro recibe un mensaje directo con el resultado.</span><button class="btn sm" style="margin-left:auto" data-act="approveAll">${icon('check')} Aprobar todas (${items.length})</button></div>
          <div class="grid cols-3">${items.map(card)}</div>`
      : html`<div class="card">${emptyState('shield', 'No hay nada pendiente', 'Cuando un miembro envíe una captura o una declaración que necesite revisión, aparecerá aquí (y en el canal de registro de Discord, si lo configuraste).')}</div>`,
  );
}

async function load() {
  const ctx = ctxRef;
  if (!ctx) return;
  const r = await get(`/guilds/${ctx.params.guildId}/reviews`);
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  items = r.items;
  renderList();
}

async function decide(sid, approve, reason = null) {
  await post(`/guilds/${state.guildId}/reviews/${sid}`, { approve, reason });
  items = items.filter((i) => String(i.id) !== String(sid));
  renderList();
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    setTitle('Revisión');
    ctx.view.innerHTML = String(html`<div id="reviews"><div class="skeleton"></div></div>`);
    await load();
  },
  onLive(ev) {
    if (ev.kind !== 'submission') return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => load().catch(() => {}), 800);
  },
  destroy() {
    clearTimeout(liveTimer);
    ctxRef = null;
  },
  actions: {
    member(el) {
      location.hash = `#/g/${state.guildId}/miembros/${el.dataset.uid}`;
    },
    approve(el) {
      return withBusy(el, async () => {
        await decide(el.dataset.sid, true);
        toast('Aprobado. Se sumaron los puntos.', 'success');
      });
    },
    async reject(el) {
      await modal({
        title: 'Rechazar envío',
        body: html`<div class="field"><label for="reason">Motivo (lo verá el miembro)</label><textarea class="input" id="reason" name="reason" maxlength="300" placeholder="Ej.: la captura no muestra que diste like al post correcto"></textarea></div>`,
        submitLabel: 'Rechazar',
        danger: true,
        onSubmit: async (form) => {
          await decide(el.dataset.sid, false, form.reason.value.trim() || null);
          toast('Rechazado.', 'success');
        },
      });
    },
    async approveAll(el) {
      await withBusy(el, async () => {
        const ids = items.map((i) => i.id);
        let ok = 0;
        for (const id of ids) {
          try {
            await post(`/guilds/${state.guildId}/reviews/${id}`, { approve: true });
            ok += 1;
          } catch {
            /* se muestra el resto */
          }
        }
        toast(`${ok} envíos aprobados.`, 'success');
        await load();
      });
    },
  },
};
