import { get, post } from '../api.js';
import { html, icon, toast, modal, withBusy, emptyState, $ } from '../ui.js';
import { renderMessage } from '../discord.js';
import { setTitle, state as appState } from '../main.js';

let ctxRef = null;
let sim = null;
let userId = null;
let channelId = null;
let view = 'channel'; // channel | dm
let pollTimer = null;
let busy = false;
let sigs = { msg: '', side: '', modal: '' };
let lastPost = null; // último comentario/cita publicado en el X simulado (se conserva entre refrescos)

const OPT = { SUB: 1, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, NUMBER: 10, ATTACHMENT: 11 };

function mentionCtx() {
  return {
    users: Object.fromEntries((sim?.users || []).map((u) => [u.id, u.name])),
    roles: Object.fromEntries((sim?.roles || []).map((r) => [r.id, r])),
    channels: Object.fromEntries((sim?.channels || []).map((c) => [c.id, c.name])),
  };
}

function flatCommands() {
  const out = [];
  for (const c of sim?.commands || []) {
    const subs = (c.options || []).filter((o) => o.type === OPT.SUB);
    if (subs.length) for (const s of subs) out.push({ name: c.name, sub: s.name, description: s.description, options: s.options || [] });
    else out.push({ name: c.name, sub: null, description: c.description, options: c.options || [] });
  }
  return out;
}

function me() {
  return sim?.users.find((u) => u.id === userId);
}

// ─── Render ───────────────────────────────────────────────────────
function renderMessages() {
  const box = $('#sim-msgs');
  if (!box || !sim) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const list = view === 'dm' ? sim.dms : sim.messages;
  const ctx = mentionCtx();
  box.innerHTML = list.length
    ? list.map((m) => String(renderMessage(m, ctx))).join('')
    : String(emptyState('message', view === 'dm' ? 'Sin mensajes directos' : 'Canal vacío', view === 'dm' ? 'Aquí llegan los recordatorios por MD y los resultados de las revisiones.' : 'Escribe / abajo para usar un comando.'));
  if (atBottom || box.dataset.first !== '1') {
    box.scrollTop = box.scrollHeight;
    box.dataset.first = '1';
  }
}

function renderSide() {
  const side = $('#sim-side');
  if (!side || !sim) return;
  const u = me();
  const tasks = sim.activeTasks;
  side.innerHTML = String(html`
    <div class="card"><div class="card-head"><h3>Actuar como</h3></div><div class="card-body"><div class="sim-user-list">
      ${sim.users.map(
        (x) => html`<button class="${x.id === userId ? 'active' : ''}" data-act="asUser" data-uid="${x.id}"><img class="avatar sm" src="${x.avatar}" alt="" /><span style="flex:1;min-width:0" class="ellipsis">${x.name}</span>${x.staff ? html`<span class="badge danger">staff</span>` : ''}${x.linked ? html`<span class="badge ${x.linked.verified ? 'success' : 'warning'}" title="X vinculada">X</span>` : ''}</button>`,
      )}
    </div></div></div>

    <div class="card"><div class="card-head"><h3>${icon('xlogo')} X simulado · @${u?.xHandle}</h3></div><div class="card-body stack" style="gap:10px">
      <div class="field"><label class="small">Biografía</label>
        <div class="input-group"><input class="input" id="sim-bio" value="${u?.xBio || ''}" maxlength="160" /><button class="btn sm" data-act="saveBio" title="Guardar biografía">${icon('check')}</button></div>
        <span class="hint">Pega aquí el código ENG-… para verificar la cuenta.</span></div>
      ${tasks.length
        ? tasks.map(
            (t) => html`<div class="x-post"><div class="small"><strong>Tarea #${t.id}</strong> · @${t.author}</div><div class="small muted ellipsis">${t.text}</div>
              <div class="row" style="margin-top:6px;gap:6px">
                <button class="btn xs" data-act="xDo" data-type="like" data-tid="${t.tweetId}">❤️ Like</button>
                <button class="btn xs" data-act="xDo" data-type="repost" data-tid="${t.tweetId}">🔁 Repost</button>
                <button class="btn xs" data-act="xReply" data-type="reply" data-tid="${t.tweetId}">💬 Comentar</button>
                <button class="btn xs" data-act="xReply" data-type="quote" data-tid="${t.tweetId}">🗨️ Citar</button>
              </div></div>`,
          )
        : html`<p class="small muted">No hay tareas activas. Crea una con <code>/tarea crear</code> (como staff) o desde “Nueva tarea”.</p>`}
      <div id="sim-last-post">${lastPost && lastPost.userId === userId ? html`<div class="alert success small">${icon('check')}<div>Publicado. Enlace de tu ${lastPost.quote ? 'cita' : 'comentario'}:<div class="row" style="margin-top:6px"><code class="ellipsis" style="max-width:190px">${lastPost.url}</code><button class="btn xs" data-act="copy" data-text="${lastPost.url}">${icon('copy')} Copiar</button></div></div></div>` : ''}</div>
    </div></div>

    <div class="card"><div class="card-head"><h3>${icon('fast')} Herramientas</h3></div><div class="card-body stack" style="gap:8px">
      <button class="btn sm" data-act="brandPost">${icon('send')} Publicar un post de la marca</button>
      ${sim.brandPosts.length ? html`<div class="small muted">Posts de @marca_demo para crear tareas:</div>${sim.brandPosts.slice(0, 4).map((p) => html`<div class="x-post small"><div class="ellipsis">${p.text}</div><div class="row" style="margin-top:4px"><button class="btn xs" data-act="copy" data-text="${p.url}">${icon('copy')} Copiar enlace</button><a class="btn xs" href="#/g/${sim.guild.id}/tareas/nueva?url=${encodeURIComponent(p.url)}">${icon('plus')} Tarea</a></div></div>`)}` : ''}
      ${tasks.length ? html`<div class="field"><label class="small">Adelantar el tiempo de una tarea</label><div class="input-group"><select class="input" id="adv-task">${tasks.map((t) => html`<option value="${t.id}">#${t.id}</option>`)}</select><select class="input" id="adv-min"><option value="15">+15 min</option><option value="45">+45 min</option><option value="600">+10 h (cerrar)</option></select><button class="btn sm" data-act="advance">${icon('fast')}</button></div><span class="hint">Simula que pasa el tiempo para ver recordatorios y el cierre automático.</span></div>` : ''}
    </div></div>`);
}

function renderChannels() {
  const box = $('#sim-channels');
  if (!box || !sim) return;
  box.innerHTML = String(html`<div class="gname">${sim.guild.name}</div>
    ${sim.channels.map((c) => html`<button class="${view === 'channel' && c.id === channelId ? 'active' : ''}" data-act="channel" data-cid="${c.id}"># ${c.name}</button>`)}
    <div class="gname" style="margin-top:14px;border:0;padding-bottom:4px;font-size:12px;text-transform:uppercase">Mensajes directos</div>
    <button class="${view === 'dm' ? 'active' : ''}" data-act="dms">✉️ Engage Bot${sim.dms.length ? ` (${sim.dms.length})` : ''}</button>`);
  const head = $('#sim-head');
  if (head) head.innerHTML = String(view === 'dm' ? html`✉️ Engage Bot <span class="small" style="color:var(--dc-muted);font-weight:400">mensajes directos de ${me()?.name}</span>` : html`# ${sim.channels.find((c) => c.id === channelId)?.name || ''}`);
}

function renderModal() {
  const m = sim?.modal;
  const root = $('#sim-modal-root');
  if (!root) return;
  if (!m) {
    root.innerHTML = '';
    root.dataset.cid = '';
    return;
  }
  // La clave incluye al usuario: dos miembros pueden abrir el mismo formulario seguidos.
  const key = `${userId}:${m.custom_id}`;
  if (root.dataset.cid === key && root.firstElementChild) return;
  root.dataset.cid = key;
  root.innerHTML = String(html`<div class="modal-back sim-modal"><form class="modal dc" style="width:min(460px,100%)" id="sim-modal-form">
    <div class="modal-head" style="border-color:rgba(0,0,0,.2)"><h3 style="color:var(--dc-text)">${m.title}</h3><button type="button" class="icon-btn" data-act="cancelModal" aria-label="Cerrar">${icon('x')}</button></div>
    <div class="modal-body">${m.components.map(
      (c) => html`<div class="field"><label style="color:var(--dc-text);text-transform:uppercase;font-size:12px">${c.label}${c.component.required !== false ? html` <span style="color:#f23f43">*</span>` : ''}</label>${c.description ? html`<span class="hint" style="color:var(--dc-muted)">${c.description}</span>` : ''}
        ${c.component.style === 2 ? html`<textarea class="input" name="${c.component.custom_id}" maxlength="${c.component.max_length || 4000}" placeholder="${c.component.placeholder || ''}"></textarea>` : html`<input class="input" name="${c.component.custom_id}" maxlength="${c.component.max_length || 4000}" placeholder="${c.component.placeholder || ''}" autocomplete="off" />`}</div>`,
    )}</div>
    <div class="modal-foot" style="border-color:rgba(0,0,0,.2)"><button type="button" class="btn ghost" data-act="cancelModal">Cancelar</button><button type="submit" class="btn" style="background:#5865f2;border-color:#5865f2;color:#fff">Enviar</button></div>
  </form></div>`);
  const form = $('#sim-modal-form');
  form.querySelector('input,textarea')?.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = Object.fromEntries([...form.elements].filter((el) => el.name).map((el) => [el.name, el.value]));
    await act(() => post('/sim/modal', { userId, fields }), form.querySelector('button[type=submit]'));
  });
}

function renderAll() {
  renderChannels();
  renderMessages();
  renderSide();
  renderModal();
}

/** Redibuja sólo las partes que cambiaron (así no se pierde lo que estás escribiendo). */
async function refresh(force = false) {
  if (!ctxRef) return;
  const s = await get(`/sim/state?user=${userId || ''}&channel=${channelId || ''}`);
  if (!ctxRef) return;
  sim = s;
  userId = s.userId;
  channelId = s.channelId;
  const next = {
    msg: JSON.stringify([view, s.channelId, s.userId, s.messages.map((m) => [m.id, m.editedAt]), s.dms.map((m) => m.id)]),
    side: JSON.stringify([s.userId, s.activeTasks.map((t) => t.id), s.users.map((u) => [u.id, u.linked?.verified, u.xBio]), s.brandPosts.map((p) => p.id), lastPost?.url]),
    modal: s.modal ? `${s.userId}:${s.modal.custom_id}` : '',
  };
  if (force || next.msg !== sigs.msg) {
    renderChannels();
    renderMessages();
  }
  const typing = document.activeElement?.closest?.('#sim-side input, #sim-side select, #sim-side textarea');
  if ((force && !typing) || (next.side !== sigs.side && !typing)) renderSide();
  if (force || next.modal !== sigs.modal) renderModal();
  sigs = typing ? { ...next, side: sigs.side } : next;
}

/** Ejecuta una acción del simulador y muestra sus errores (incluidos los que Discord habría rechazado). */
async function act(fn, btn = null) {
  if (busy) return null;
  busy = true;
  try {
    const run = async () => {
      const r = await fn();
      if (r && r.ok === false) {
        const msg = r.error || r.log?.find((l) => l.type === 'error')?.message || 'La interacción falló';
        toast(msg, 'error', 7000);
      }
      return r;
    };
    const r = btn ? await withBusy(btn, run) : await run();
    await refresh();
    // Como en Discord: tras usar un botón o comando, la respuesta del bot se ve abajo del todo.
    const box = $('#sim-msgs');
    if (box) box.scrollTop = box.scrollHeight;
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  } finally {
    busy = false;
  }
}

// ─── Comandos ─────────────────────────────────────────────────────
function optionField(o) {
  const req = o.required ? html` <span style="color:var(--danger)">*</span>` : '';
  const label = html`<label>${o.name}${req} <span class="hint">${o.description}</span></label>`;
  const name = o.name;
  if (o.choices?.length) return html`<div class="field">${label}<select class="input" name="${name}">${o.required ? '' : html`<option value="">—</option>`}${o.choices.map((c) => html`<option value="${c.value}">${c.name}</option>`)}</select></div>`;
  switch (o.type) {
    case OPT.BOOLEAN:
      return html`<div class="field">${label}<select class="input" name="${name}"><option value="">—</option><option value="true">true (sí)</option><option value="false">false (no)</option></select></div>`;
    case OPT.USER:
      return html`<div class="field">${label}<select class="input" name="${name}">${o.required ? '' : html`<option value="">—</option>`}${sim.users.map((u) => html`<option value="${u.id}">${u.name}</option>`)}</select></div>`;
    case OPT.CHANNEL:
      return html`<div class="field">${label}<select class="input" name="${name}">${o.required ? '' : html`<option value="">—</option>`}${sim.channels.map((c) => html`<option value="${c.id}">#${c.name}</option>`)}</select></div>`;
    case OPT.ROLE:
      return html`<div class="field">${label}<select class="input" name="${name}">${o.required ? '' : html`<option value="">—</option>`}${sim.roles.map((r) => html`<option value="${r.id}">@${r.name}</option>`)}</select></div>`;
    case OPT.ATTACHMENT:
      return html`<div class="field">${label}<input class="input" type="file" name="${name}" accept="image/png,image/jpeg,image/webp,image/gif" style="padding:6px" /><label class="check small"><input type="checkbox" name="__sample" checked /> Usar una captura de ejemplo</label></div>`;
    case OPT.INTEGER:
    case OPT.NUMBER:
      if (o.autocomplete) {
        return html`<div class="field">${label}<select class="input" name="${name}" data-autocomplete="1">${o.required ? '' : html`<option value="">—</option>`}${sim.activeTasks.map((t) => html`<option value="${t.id}">#${t.id} · @${t.author}</option>`)}</select><span class="hint">Opciones del autocompletado del bot</span></div>`;
      }
      return html`<div class="field">${label}<input class="input" type="number" name="${name}" ${o.min_value !== undefined ? html`min="${o.min_value}"` : ''} step="${o.type === OPT.NUMBER ? 'any' : '1'}" /></div>`;
    default: {
      const list = name === 'enlace' ? html`<datalist id="dl-links">${sim.brandPosts.map((p) => html`<option value="${p.url}">${p.text.slice(0, 60)}</option>`)}</datalist>` : '';
      return html`<div class="field">${label}<input class="input" name="${name}" ${name === 'enlace' ? 'list="dl-links"' : ''} maxlength="${o.max_length || 300}" autocomplete="off" />${list}</div>`;
    }
  }
}

async function readFile(file) {
  const buf = await file.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function openCommand(cmd) {
  closePalette();
  const input = $('#sim-input');
  if (input) input.value = '';
  if (!cmd.options.length) {
    return act(() => post('/sim/command', { userId, channelId: view === 'dm' ? null : channelId, name: cmd.name, subcommand: cmd.sub }));
  }
  let payload = null;
  await modal({
    title: `/${cmd.name}${cmd.sub ? ` ${cmd.sub}` : ''}`,
    body: html`<p class="small muted" style="margin-top:0">${cmd.description}</p><div class="stack" style="gap:12px">${cmd.options.map(optionField)}</div>`,
    submitLabel: 'Enviar comando',
    onSubmit: async (form) => {
      const options = {};
      let attachment = null;
      for (const o of cmd.options) {
        const el = form.elements[o.name];
        if (!el) continue;
        if (o.type === OPT.ATTACHMENT) {
          const file = el.files?.[0];
          if (file) attachment = { option: o.name, name: file.name, contentType: file.type, dataBase64: await readFile(file) };
          else if (form.elements.__sample?.checked) attachment = { option: o.name, sample: true };
          continue;
        }
        if (el.value !== '') options[o.name] = el.value;
      }
      const missing = cmd.options.filter((o) => o.required && o.type !== OPT.ATTACHMENT && !(o.name in options));
      if (missing.length) throw new Error(`Falta: ${missing.map((o) => o.name).join(', ')}`);
      if (cmd.options.some((o) => o.type === OPT.ATTACHMENT && o.required) && !attachment) throw new Error('Adjunta una imagen');
      payload = { userId, channelId: view === 'dm' ? null : channelId, name: cmd.name, subcommand: cmd.sub, options, attachment };
      return true;
    },
  });
  if (payload) {
    if (view === 'dm') view = 'channel';
    return act(() => post('/sim/command', payload));
  }
  return null;
}

function openPalette(filter = '') {
  const pal = $('#sim-palette');
  if (!pal) return;
  const f = filter.replace(/^\//, '').toLowerCase();
  const all = flatCommands();
  const cmds = all.map((c, index) => ({ c, index })).filter(({ c }) => `${c.name} ${c.sub || ''}`.includes(f));
  pal.hidden = false;
  pal.innerHTML = String(
    cmds.length
      ? html`${cmds.map(({ c, index }, i) => html`<button type="button" data-act="pickCommand" data-i="${index}" ${i === 0 ? 'data-first="1"' : ''}><strong>/${c.name}${c.sub ? ` ${c.sub}` : ''}</strong><small>${c.description}</small></button>`)}`
      : html`<p class="small" style="padding:8px;margin:0;color:var(--dc-muted)">Sin comandos que coincidan.</p>`,
  );
}

function closePalette() {
  const pal = $('#sim-palette');
  if (pal) pal.hidden = true;
}

// ─── Página ───────────────────────────────────────────────────────
export default {
  async render(ctx) {
    ctxRef = ctx;
    sigs = { msg: '', side: '', modal: '' };
    setTitle('Simulador', 'Prueba el bot completo sin Discord ni X reales');
    if (!appState.session?.simulator) {
      ctx.view.innerHTML = String(html`<div class="card">${emptyState('flask', 'Simulador desactivado', 'Arranca el bot con “npm run demo” (o SIMULATOR=true sin token) para probarlo todo sin Discord.')}</div>`);
      return;
    }
    ctx.view.innerHTML = String(html`
      <div class="alert info small" style="margin-bottom:12px">${icon('info')}<span>Esto es un servidor de Discord <strong>simulado</strong> conectado al código real del bot: los mismos comandos, botones, formularios y reglas de Discord (límites de mensajes, 3 s para responder…). Elige a quién interpretar a la derecha.</span></div>
      <div class="sim">
        <nav class="sim-channels" id="sim-channels"></nav>
        <div class="sim-chat">
          <div class="sim-chat-head" id="sim-head"></div>
          <div class="sim-messages dc" id="sim-msgs" style="border-radius:0"></div>
          <div class="sim-composer">
            <div class="sim-palette" id="sim-palette" hidden></div>
            <div class="box">${icon('plus')}<input id="sim-input" placeholder="Escribe / para usar un comando del bot" autocomplete="off" aria-label="Comando" /></div>
          </div>
        </div>
        <aside class="sim-side" id="sim-side"></aside>
      </div>
      <div id="sim-modal-root"></div>`);
    const input = $('#sim-input');
    input.addEventListener('input', () => (input.value.startsWith('/') ? openPalette(input.value) : closePalette()));
    input.addEventListener('focus', () => input.value.startsWith('/') && openPalette(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePalette();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = $('#sim-palette [data-first]');
        if (first && !$('#sim-palette').hidden) openCommand(flatCommands()[Number(first.dataset.i)]);
      }
    });
    document.addEventListener('mousedown', outsidePalette);
    await refresh(true);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!busy && !document.hidden) refresh().catch(() => {});
    }, 2500);
  },
  destroy() {
    clearInterval(pollTimer);
    document.removeEventListener('mousedown', outsidePalette);
    ctxRef = null;
    sim = null;
  },
  actions: {
    dcButton(el) {
      if (el.disabled) return null;
      return act(() => post('/sim/button', { userId, messageId: el.dataset.mid, customId: el.dataset.cid }), el);
    },
    asUser(el) {
      userId = el.dataset.uid;
      return refresh(true);
    },
    channel(el) {
      view = 'channel';
      channelId = el.dataset.cid;
      $('#sim-msgs').dataset.first = '0';
      return refresh(true);
    },
    dms() {
      view = 'dm';
      $('#sim-msgs').dataset.first = '0';
      renderAll();
    },
    cancelModal() {
      $('#sim-modal-root').dataset.cid = '';
      return act(() => post('/sim/modal/cancel', { userId }));
    },
    pickCommand(el) {
      return openCommand(flatCommands()[Number(el.dataset.i)]);
    },
    saveBio(el) {
      return act(() => post('/sim/x', { userId, type: 'bio', text: $('#sim-bio').value }).then((r) => (toast('Biografía actualizada en X (simulado).', 'success'), r)), el);
    },
    xDo(el) {
      const label = el.dataset.type === 'like' ? 'Like dado' : 'Repost hecho';
      return act(() => post('/sim/x', { userId, type: el.dataset.type, tweetId: el.dataset.tid }).then((r) => (toast(`${label} en X (simulado).`, 'success'), r)), el);
    },
    async xReply(el) {
      const quote = el.dataset.type === 'quote';
      const r = await modal({
        title: quote ? 'Citar el post en X (simulado)' : 'Comentar en X (simulado)',
        body: html`<div class="field"><label for="xt">Texto</label><textarea class="input" id="xt" name="text" maxlength="280" required placeholder="${quote ? 'Tu opinión sobre el post…' : 'Escribe un comentario con contenido (prueba también “gm” o “🔥🔥” para ver el rechazo)'}"></textarea></div>`,
        submitLabel: quote ? 'Publicar cita' : 'Responder',
        onSubmit: (form) => post('/sim/x', { userId, type: el.dataset.type, tweetId: el.dataset.tid, text: form.text.value }),
      });
      if (r?.url) {
        lastPost = { userId, url: r.url, quote };
        await refresh(true);
        try {
          await navigator.clipboard.writeText(r.url);
          toast('Enlace copiado: pégalo en el formulario del bot.', 'success');
        } catch {
          /* sin permiso de portapapeles */
        }
      }
    },
    async copy(el) {
      try {
        await navigator.clipboard.writeText(el.dataset.text);
        toast('Copiado.', 'success');
      } catch {
        toast(el.dataset.text, 'info', 8000);
      }
    },
    async brandPost() {
      await modal({
        title: 'Publicar como @marca_demo',
        body: html`<div class="field"><label for="bp">Texto del post</label><textarea class="input" id="bp" name="text" maxlength="280" required>🎉 ¡Sorteo de aniversario! Comenta qué es lo que más te gusta de la comunidad y participa por una suscripción anual.</textarea></div>`,
        submitLabel: 'Publicar',
        onSubmit: async (form) => {
          await post('/sim/x', { type: 'post', text: form.text.value });
          toast('Post publicado. Úsalo para crear una tarea.', 'success');
        },
      });
      await refresh(true);
    },
    advance(el) {
      const taskId = $('#adv-task').value;
      const minutes = Number($('#adv-min').value);
      return act(() => post('/sim/advance', { taskId, minutes }).then((r) => (toast(`La tarea #${taskId} avanzó ${minutes} min.`, 'success'), r)), el);
    },
  },
};

function outsidePalette(e) {
  if (!e.target.closest('.sim-composer')) closePalette();
}

