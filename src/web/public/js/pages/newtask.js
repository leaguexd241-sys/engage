import { post } from '../api.js';
import { html, icon, compact, dateTime, toast, withBusy, ACTIONS, $ } from '../ui.js';
import { renderPayload } from '../discord.js';
import { setTitle, state, loadMeta } from '../main.js';

let ctxRef = null;
let tweet = null;
let previewTimer = null;
let previewSeq = 0;

const DURATIONS = [
  ['15m', '15 minutos'],
  ['30m', '30 minutos'],
  ['1h', '1 hora'],
  ['2h', '2 horas'],
  ['6h', '6 horas'],
  ['12h', '12 horas'],
  ['1d', '1 día'],
  ['3d', '3 días'],
  ['7d', '7 días'],
];

function mentionCtx(meta) {
  return {
    roles: Object.fromEntries((meta?.roles || []).map((r) => [r.id, r])),
    channels: Object.fromEntries((meta?.channels || []).map((c) => [c.id, c.name])),
  };
}

function tweetCard(t) {
  if (!t) return html`<div class="empty" style="padding:28px 12px">${icon('link')}<p class="small">Pega el enlace de un post de X y pulsa <strong>Cargar</strong> para verlo aquí.</p></div>`;
  const img = t.media?.find((m) => m.url)?.url;
  return html`<div class="tweet">
    <div class="tweet-head">${t.author?.avatar ? html`<img src="${t.author.avatar}" alt="" referrerpolicy="no-referrer" />` : ''}<div><strong>${t.author?.name}</strong><span>@${t.author?.handle} · ${dateTime(t.createdAt)}</span></div></div>
    <div class="tweet-text">${t.text}</div>
    ${img ? html`<img class="tweet-media" src="${img}" alt="" referrerpolicy="no-referrer" />` : ''}
    <div class="tweet-metrics"><span>❤️ ${compact(t.metrics?.likes)}</span><span>🔁 ${compact(t.metrics?.reposts)}</span><span>💬 ${compact(t.metrics?.replies)}</span>${t.metrics?.views != null ? html`<span>👁️ ${compact(t.metrics.views)}</span>` : ''}</div>
  </div>`;
}

function formValues(form) {
  const actions = [...form.querySelectorAll('input[name=actions]:checked')].map((i) => i.value);
  const points = {};
  for (const k of ['like', 'repost', 'reply', 'quote', 'bonus']) {
    const v = form[`p_${k}`]?.value;
    if (v !== '' && v !== undefined) points[k] = Number(v);
  }
  const duration = form.duration.value === 'custom' ? form.durationCustom.value.trim() : form.duration.value;
  return {
    tweetUrl: form.url.value.trim(),
    actions,
    duration,
    channelId: form.channelId.value || undefined,
    roleId: form.roleId.value || null,
    pingRoleId: form.pingRoleId.value || null,
    note: form.note.value.trim() || undefined,
    points,
  };
}

async function updatePreview() {
  const form = $('#new-task');
  if (!form) return;
  const seq = ++previewSeq;
  const v = formValues(form);
  const box = $('#preview');
  if (!tweet) {
    box.innerHTML = String(html`<p class="muted small" style="padding:12px">La vista previa aparece cuando cargas un post.</p>`);
    return;
  }
  try {
    const r = await post(`/guilds/${state.guildId}/tasks/preview`, { tweet, actions: v.actions, duration: v.duration, note: v.note, points: v.points, pingRoleId: v.pingRoleId });
    if (seq !== previewSeq || !$('#preview')) return;
    $('#preview').innerHTML = String(renderPayload(r.payload, mentionCtx(state.meta)));
  } catch (err) {
    if (seq === previewSeq && $('#preview')) $('#preview').innerHTML = String(html`<p class="small" style="color:var(--danger);padding:12px">${err.message}</p>`);
  }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 250);
}

async function loadTweet(btn) {
  const form = $('#new-task');
  const url = form.url.value.trim();
  if (!url) {
    form.url.classList.add('invalid');
    form.url.focus();
    return;
  }
  form.url.classList.remove('invalid');
  await withBusy(btn, async () => {
    try {
      const r = await post('/tweet-preview', { url });
      tweet = r.tweet;
      $('#tweet-box').innerHTML = String(tweetCard(tweet));
      $('#submit-btn').disabled = false;
      $('#submit-hint').textContent = 'Todo listo: revisa la vista previa y publica.';
      schedulePreview();
    } catch (err) {
      tweet = null;
      $('#tweet-box').innerHTML = String(html`<div class="alert danger">${icon('alert')}<span>${err.message}</span></div>`);
      $('#submit-btn').disabled = true;
      $('#submit-hint').textContent = 'Carga el post para poder publicar.';
      schedulePreview();
    }
  });
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    tweet = null;
    setTitle('Nueva tarea', 'Publica un post de X para que tus miembros interactúen');
    const meta = await loadMeta();
    if (!ctx.isCurrent()) return;
    const s = meta.settings;
    const chan = (c) => html`<option value="${c.id}" ${c.id === s.tasksChannelId ? 'selected' : ''}>#${c.name}${c.canPost ? '' : ' (sin permisos)'}</option>`;
    const roleOpt = (sel) => (r) => html`<option value="${r.id}" ${r.id === sel ? 'selected' : ''}>@${r.name}</option>`;
    const channelWarning = !s.tasksChannelId && meta.channels.length ? html`<span class="hint">Consejo: fija un canal por defecto en Ajustes.</span>` : '';
    ctx.view.innerHTML = String(html`
      <form id="new-task" class="grid cols-main" novalidate>
        <div class="stack">
          <div class="card"><div class="card-head"><h2>1 · El post de X</h2></div><div class="card-body stack">
            <div class="field">
              <label for="url">Enlace del post</label>
              <div class="input-group"><input class="input" id="url" name="url" placeholder="https://x.com/usuario/status/1234567890" autocomplete="off" required /><button type="button" class="btn" data-act="load">${icon('eye')} Cargar</button></div>
              <span class="hint">Funciona con x.com, twitter.com, fxtwitter, vxtwitter… El post debe ser público.</span>
            </div>
            <div id="tweet-box">${tweetCard(null)}</div>
          </div></div>

          <div class="card"><div class="card-head"><h2>2 · Qué deben hacer</h2></div><div class="card-body stack">
            <div class="chips">${Object.entries(ACTIONS).map(([k, a]) => html`<label class="chip-toggle"><input type="checkbox" name="actions" value="${k}" data-change="preview" ${s.defaultActions.includes(k) ? 'checked' : ''} />${a.emoji} ${a.label}</label>`)}</div>
            <div class="alert info small">${icon('info')}<span><strong>Comentarios y citas</strong> se verifican leyendo X (autor, destino, calidad y copias). <strong>Reposts</strong> se buscan en el perfil público. <strong>Likes</strong> son privados en X desde 2024: se aceptan según el modo de verificación de Ajustes.</span></div>
            <div class="form-grid">
              <div class="field"><label for="duration">Duración</label>
                <select class="input" id="duration" name="duration" data-change="duration">${DURATIONS.map(([v, l]) => html`<option value="${v}" ${v === pickDefault(s.defaultDurationMinutes) ? 'selected' : ''}>${l}</option>`)}<option value="custom" ${pickDefault(s.defaultDurationMinutes) === 'custom' ? 'selected' : ''}>Personalizada…</option></select>
                <input class="input" name="durationCustom" placeholder="Ej.: 45m, 1h30m" value="${pickDefault(s.defaultDurationMinutes) === 'custom' ? `${s.defaultDurationMinutes}m` : ''}" ${pickDefault(s.defaultDurationMinutes) === 'custom' ? '' : 'hidden'} data-input="preview" />
              </div>
              <div class="field"><label for="channelId">Canal de Discord</label>
                <select class="input" id="channelId" name="channelId">${meta.channels.length ? '' : html`<option value="">(el bot no ve canales)</option>`}${!s.tasksChannelId ? html`<option value="">Elige un canal…</option>` : ''}${meta.channels.map(chan)}</select>${channelWarning}
              </div>
              <div class="field"><label for="roleId">Quién debe hacerla</label>
                <select class="input" id="roleId" name="roleId"><option value="">Miembros con X vinculada</option>${meta.roles.map(roleOpt(s.participantRoleId))}</select>
                <span class="hint">Con un rol, el informe dirá exactamente quién no la hizo.</span>
              </div>
              <div class="field"><label for="pingRoleId">Mencionar al publicar</label>
                <select class="input" id="pingRoleId" name="pingRoleId" data-change="preview"><option value="">No mencionar</option>${meta.roles.map(roleOpt(s.pingRoleId))}</select>
              </div>
              <div class="field full"><label for="note">Nota para los miembros <span class="muted">(opcional)</span></label><textarea class="input" id="note" name="note" maxlength="500" placeholder="Ej.: comentad qué os parece la nueva función 🙌" data-input="preview"></textarea></div>
            </div>
          </div></div>

          <div class="card"><div class="card-head"><h2>3 · Recompensa</h2><div class="sub">Puntos por acción verificada</div></div><div class="card-body">
            <div class="form-grid" style="grid-template-columns:repeat(5,minmax(0,1fr))">
              ${[...Object.entries(ACTIONS), ['bonus', { emoji: '🏆', label: 'Bonus' }]].map(([k, a]) => html`<div class="field"><label for="p_${k}">${a.emoji} ${a.label}</label><input class="input" type="number" min="0" max="1000" id="p_${k}" name="p_${k}" value="${s.points[k]}" data-input="preview" /></div>`)}
            </div>
            <p class="hint" style="margin:10px 0 0">El bonus se suma cuando un miembro completa todas las acciones.</p>
          </div>
          <div class="form-actions"><span class="small muted" id="submit-hint">Carga el post para poder publicar.</span><button type="submit" class="btn primary" id="submit-btn" disabled>${icon('send')} Publicar tarea</button></div>
          </div>
        </div>

        <div class="stack">
          <div class="card" style="position:sticky;top:84px">
            <div class="card-head"><div><h2>Vista previa en Discord</h2><div class="sub">Así verán la tarea tus miembros</div></div></div>
            <div class="card-body"><div id="preview" class="dc" style="min-height:120px"><p class="muted small" style="padding:12px">La vista previa aparece cuando cargas un post.</p></div></div>
          </div>
        </div>
      </form>`);

    const form = $('#new-task');
    form.url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        loadTweet($('[data-act=load]'));
      }
    });
    form.url.addEventListener('paste', () => setTimeout(() => loadTweet($('[data-act=load]')), 30));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(form);
      if (!tweet) return toast('Primero carga el post de X.', 'error');
      if (!v.actions.length) return toast('Elige al menos una acción.', 'error');
      if (!v.channelId) return toast('Elige el canal donde se publicará.', 'error');
      const btn = $('#submit-btn');
      await withBusy(btn, async () => {
        try {
          const r = await post(`/guilds/${state.guildId}/tasks`, v);
          toast(`Tarea #${r.task.id} publicada en Discord.`, 'success');
          location.hash = `#/g/${state.guildId}/tareas/${r.task.id}`;
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      return undefined;
    });
    if (ctx.query.url) {
      form.url.value = ctx.query.url;
      loadTweet($('[data-act=load]'));
    } else form.url.focus();
  },
  destroy() {
    clearTimeout(previewTimer);
    ctxRef = null;
    tweet = null;
  },
  actions: {
    load(el) {
      return loadTweet(el);
    },
    preview() {
      schedulePreview();
    },
    duration(el) {
      const custom = el.form.durationCustom;
      custom.hidden = el.value !== 'custom';
      if (!custom.hidden) custom.focus();
      schedulePreview();
    },
  },
};

function pickDefault(minutes) {
  const map = { 15: '15m', 30: '30m', 60: '1h', 120: '2h', 360: '6h', 720: '12h', 1440: '1d', 4320: '3d', 10080: '7d' };
  return map[minutes] || 'custom';
}
