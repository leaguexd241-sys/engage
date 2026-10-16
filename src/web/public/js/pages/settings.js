import { put, post } from '../api.js';
import { html, icon, toast, withBusy, ACTIONS, $, $$ } from '../ui.js';
import { setTitle, state, loadMeta } from '../main.js';

let ctxRef = null;
let original = null;
let qualityTimer = null;

const PROOF = [
  ['declared', 'Declaración', 'El miembro pulsa “Ya lo hice” y cuenta al momento. Rápido; el bot contrasta el total con el contador público del post y avisa si no cuadra.'],
  ['screenshot', 'Captura obligatoria', 'Debe subir una captura con /prueba. Se aprueba sola si su confianza es alta; si no, va a Revisión.'],
  ['review', 'Revisión manual', 'Cada like/repost declarado espera a que alguien del staff lo apruebe (en el panel o en el canal de registro).'],
];

function sw(name, checked, label, hint = '') {
  return html`<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} data-change="dirty" /><span class="track"></span><span><span class="label">${label}</span>${hint ? html`<br /><span class="hint">${hint}</span>` : ''}</span></label>`;
}

function select(name, value, options, { allowNone = true, noneLabel = 'Ninguno', prefix = '' } = {}) {
  return html`<select class="input" name="${name}" data-change="dirty">${allowNone ? html`<option value="">${noneLabel}</option>` : ''}${options.map(
    (o) => html`<option value="${o.id}" ${o.id === value ? 'selected' : ''}>${prefix}${o.name}${o.canPost === false ? ' (sin permisos)' : ''}</option>`,
  )}${value && !options.some((o) => o.id === value) ? html`<option value="${value}" selected>(no encontrado: ${value})</option>` : ''}</select>`;
}

function collect(form) {
  const v = (n) => form.elements[n];
  return {
    tasksChannelId: v('tasksChannelId').value || null,
    logChannelId: v('logChannelId').value || null,
    participantRoleId: v('participantRoleId').value || null,
    staffRoleId: v('staffRoleId').value || null,
    pingRoleId: v('pingRoleId').value || null,
    defaultActions: $$('input[name=defaultActions]:checked', form).map((i) => i.value),
    defaultDurationMinutes: Number(v('defaultDurationMinutes').value),
    points: Object.fromEntries(['like', 'repost', 'reply', 'quote', 'bonus'].map((k) => [k, Number(v(`p_${k}`).value)])),
    verification: {
      requireLink: v('requireLink').checked,
      requireVerifiedLink: v('requireVerifiedLink').checked,
      proofMode: form.querySelector('input[name=proofMode]:checked')?.value,
      autoApproveTrust: Number(v('autoApproveTrust').value),
      repostTimelineCheck: v('repostTimelineCheck').checked,
      minReplyQuality: Number(v('minReplyQuality').value),
      allowThreadReplies: v('allowThreadReplies').checked,
      antiDuplicate: v('antiDuplicate').checked,
      duplicateThreshold: Number(v('duplicateThreshold').value) / 100,
      recheckOnClose: v('recheckOnClose').checked,
      maxAttempts: Number(v('maxAttempts').value),
    },
    reminders: { enabled: v('remEnabled').checked, minutesBefore: Number(v('remMinutes').value), mode: v('remMode').value },
    report: { enabled: v('repEnabled').checked, mentionMissing: v('repMention').checked, channelId: v('repChannel').value || null },
    publicStatus: v('publicStatus').checked,
    embedColor: v('embedColor').value.toUpperCase(),
  };
}

function markDirty() {
  const form = $('#settings-form');
  if (!form) return;
  const dirty = JSON.stringify(collect(form)) !== JSON.stringify(original);
  $('#save-btn').disabled = !dirty;
  $('#dirty-msg').textContent = dirty ? 'Tienes cambios sin guardar' : 'Todo guardado';
  $('#q-val').textContent = form.elements.minReplyQuality.value;
  $('#d-val').textContent = `${form.elements.duplicateThreshold.value}%`;
  $('#t-val').textContent = form.elements.autoApproveTrust.value >= 101 ? 'nunca' : form.elements.autoApproveTrust.value;
}

async function testQuality() {
  const text = $('#q-text')?.value || '';
  const out = $('#q-out');
  if (!out) return;
  if (!text.trim()) {
    out.innerHTML = '';
    return;
  }
  const r = await post('/quality', { text, tweetText: $('#q-tweet').value });
  const min = Number($('#settings-form').elements.minReplyQuality.value);
  const ok = r.score >= min;
  out.innerHTML = String(html`<div class="alert ${ok ? 'success' : 'danger'}">${icon(ok ? 'check' : 'x')}<div><strong>${r.score}/100 · ${r.grade.label}</strong> — ${ok ? 'se aceptaría' : `se rechazaría (mínimo ${min})`}<div class="small text-2">${r.notes.join(' · ') || 'Sin observaciones'} · ${r.stats.words} palabras</div></div></div>`);
}

const page = {
  async render(ctx) {
    ctxRef = ctx;
    setTitle('Ajustes', 'Configuración del bot en este servidor');
    const meta = await loadMeta(true);
    if (!ctx.isCurrent()) return;
    const s = meta.settings;
    const v = s.verification;
    const ch = meta.channels;
    const roles = meta.roles;
    ctx.view.innerHTML = String(html`
      <form id="settings-form" class="card" novalidate>
        <div class="card-body" style="padding-top:0">
          ${meta.online ? '' : html`<div class="alert warning mt">${icon('alert')}<span>El bot no está conectado a este servidor ahora mismo: no se pueden listar canales ni roles. Los ajustes se guardan igualmente.</span></div>`}
          <section class="settings-section">
            <div><h3>Canales y roles</h3><p class="hint">Dónde publica el bot y quién participa.</p></div>
            <div class="form-grid">
              <div class="field"><label>Canal de tareas</label>${select('tasksChannelId', s.tasksChannelId, ch, { noneLabel: 'Sin configurar', prefix: '#' })}<span class="hint">Donde se publican las tareas por defecto.</span></div>
              <div class="field"><label>Canal de registro y revisiones</label>${select('logChannelId', s.logChannelId, ch, { noneLabel: 'Desactivado', prefix: '#' })}<span class="hint">Privado para el staff: aquí llegan las capturas a revisar.</span></div>
              <div class="field"><label>Rol de participantes</label>${select('participantRoleId', s.participantRoleId, roles, { noneLabel: 'Miembros con X vinculada', prefix: '@' })}<span class="hint">Quién <strong>debe</strong> hacer las tareas: así el bot sabe quién falta.</span></div>
              <div class="field"><label>Rol de staff</label>${select('staffRoleId', s.staffRoleId, roles, { prefix: '@' })}<span class="hint">Además de quien tenga “Gestionar servidor”.</span></div>
              <div class="field"><label>Rol a mencionar en cada tarea</label>${select('pingRoleId', s.pingRoleId, roles, { noneLabel: 'No mencionar', prefix: '@' })}</div>
              <div class="field"><label>Canal del informe final</label>${select('repChannel', s.report.channelId, ch, { noneLabel: 'El mismo de la tarea', prefix: '#' })}</div>
            </div>
          </section>

          <section class="settings-section">
            <div><h3>Tareas por defecto</h3><p class="hint">Valores iniciales al crear una tarea (se pueden cambiar en cada una).</p></div>
            <div class="stack">
              <div class="chips">${Object.entries(ACTIONS).map(([k, a]) => html`<label class="chip-toggle"><input type="checkbox" name="defaultActions" value="${k}" ${s.defaultActions.includes(k) ? 'checked' : ''} data-change="dirty" />${a.emoji} ${a.label}</label>`)}</div>
              <div class="form-grid">
                <div class="field"><label>Duración por defecto (minutos)</label><input class="input" type="number" min="5" max="43200" name="defaultDurationMinutes" value="${s.defaultDurationMinutes}" data-input="dirty" /></div>
                <div class="field"><label>Color de los mensajes</label><input class="input" type="color" name="embedColor" value="${s.embedColor}" data-input="dirty" style="padding:4px;width:80px" /></div>
              </div>
              <div class="form-grid" style="grid-template-columns:repeat(5,minmax(0,1fr))">
                ${[...Object.entries(ACTIONS), ['bonus', { emoji: '🏆', label: 'Bonus' }]].map(([k, a]) => html`<div class="field"><label>${a.emoji} ${a.label}</label><input class="input" type="number" min="0" max="1000" name="p_${k}" value="${s.points[k]}" data-input="dirty" /></div>`)}
              </div>
            </div>
          </section>

          <section class="settings-section">
            <div><h3>Verificación</h3><p class="hint">Cómo se comprueba cada acción sin la API de X.</p></div>
            <div class="stack">
              ${sw('requireLink', v.requireLink, 'Exigir cuenta de X vinculada', 'Necesario para comprobar que el comentario es del propio miembro.')}
              ${sw('requireVerifiedLink', v.requireVerifiedLink, 'Exigir que la cuenta esté verificada', 'El miembro demuestra que la cuenta es suya poniendo un código en su biografía.')}
              <div class="field"><span class="label">Likes y reposts (X no permite ver quién da like)</span>
                <div class="stack" style="gap:8px">${PROOF.map(([val, title, desc]) => html`<label class="check card" style="padding:12px"><input type="radio" name="proofMode" value="${val}" ${v.proofMode === val ? 'checked' : ''} data-change="dirty" /><span><strong>${title}</strong><br /><span class="hint">${desc}</span></span></label>`)}</div>
              </div>
              <div class="field"><label>Aprobar solas las capturas/declaraciones con confianza ≥ <strong id="t-val">${v.autoApproveTrust}</strong></label><input type="range" min="0" max="101" name="autoApproveTrust" value="${v.autoApproveTrust}" data-input="dirty" /><span class="hint">101 = nunca aprobar automáticamente.</span></div>
              ${sw('repostTimelineCheck', v.repostTimelineCheck, 'Buscar los reposts en el perfil público', 'Si se encuentran, cuentan como comprobados (más fiable que una declaración).')}
              <div class="field"><label>Calidad mínima de los comentarios: <strong id="q-val">${v.minReplyQuality}</strong>/100</label><input type="range" min="0" max="100" name="minReplyQuality" value="${v.minReplyQuality}" data-input="dirty" /><span class="hint">Recomendado 35: rechaza “gm”, “🔥🔥”, “buen post” y spam, pero acepta frases normales.</span></div>
              <div class="card" style="padding:12px;background:var(--surface-2)">
                <div class="label" style="margin-bottom:8px">${icon('zap')} Prueba el analizador de calidad</div>
                <div class="form-grid"><div class="field"><textarea class="input" id="q-text" placeholder="Escribe un comentario de ejemplo…" data-input="quality" style="min-height:64px"></textarea></div><div class="field"><textarea class="input" id="q-tweet" placeholder="(Opcional) texto del post original, para medir la relación" data-input="quality" style="min-height:64px"></textarea></div></div>
                <div id="q-out" class="mt"></div>
              </div>
              ${sw('antiDuplicate', v.antiDuplicate, 'Detectar comentarios copiados', 'Compara con los de otros miembros en la misma tarea y con los anteriores del propio miembro.')}
              <div class="field"><label>Similitud para considerarlo copia: <strong id="d-val">${Math.round(v.duplicateThreshold * 100)}%</strong></label><input type="range" min="50" max="100" name="duplicateThreshold" value="${Math.round(v.duplicateThreshold * 100)}" data-input="dirty" /></div>
              ${sw('allowThreadReplies', v.allowThreadReplies, 'Aceptar respuestas dentro del hilo', 'Si no, el comentario debe responder directamente al post.')}
              ${sw('recheckOnClose', v.recheckOnClose, 'Recomprobar al cerrar', 'Si alguien borra su comentario antes de que termine la tarea, se le anula.')}
              <div class="field" style="max-width:220px"><label>Intentos por acción</label><input class="input" type="number" min="1" max="20" name="maxAttempts" value="${v.maxAttempts}" data-input="dirty" /></div>
            </div>
          </section>

          <section class="settings-section">
            <div><h3>Recordatorios e informes</h3><p class="hint">Avisos automáticos para que nadie se olvide.</p></div>
            <div class="stack">
              ${sw('remEnabled', s.reminders.enabled, 'Recordar antes de que termine la tarea')}
              <div class="form-grid">
                <div class="field"><label>Minutos antes del final</label><input class="input" type="number" min="1" max="1440" name="remMinutes" value="${s.reminders.minutesBefore}" data-input="dirty" /></div>
                <div class="field"><label>Dónde avisar</label><select class="input" name="remMode" data-change="dirty"><option value="channel" ${s.reminders.mode === 'channel' ? 'selected' : ''}>En el canal (mencionando a quien falta)</option><option value="dm" ${s.reminders.mode === 'dm' ? 'selected' : ''}>Mensaje directo</option><option value="both" ${s.reminders.mode === 'both' ? 'selected' : ''}>Ambos</option></select></div>
              </div>
              ${sw('repEnabled', s.report.enabled, 'Publicar informe final', 'Al cerrar: quién completó, quién está en revisión, quién la dejó a medias y quién no participó.')}
              ${sw('repMention', s.report.mentionMissing, 'Mencionar en el informe a quien no la hizo')}
              ${sw('publicStatus', s.publicStatus, 'Cualquiera puede ver “Quién falta”', 'Si lo desactivas, el botón sólo funciona para el staff.')}
            </div>
          </section>
        </div>
        <div class="sticky-save"><span class="small muted" id="dirty-msg">Todo guardado</span><button type="button" class="btn ghost" data-act="reset">Descartar</button><button type="submit" class="btn primary" id="save-btn" disabled>${icon('check')} Guardar cambios</button></div>
      </form>`);
    const form = $('#settings-form');
    original = collect(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await withBusy($('#save-btn'), async () => {
        try {
          const r = await put(`/guilds/${state.guildId}/settings`, collect(form));
          state.meta.settings = r.settings;
          original = collect(form);
          markDirty();
          toast('Ajustes guardados. Se aplican al momento.', 'success');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      markDirty();
    });
  },
  destroy() {
    clearTimeout(qualityTimer);
    ctxRef = null;
  },
  actions: {
    dirty() {
      markDirty();
    },
    reset() {
      if (ctxRef) return page.render(ctxRef);
      return undefined;
    },
    quality() {
      clearTimeout(qualityTimer);
      qualityTimer = setTimeout(() => testQuality().catch(() => {}), 350);
    },
  },
};
export default page;
