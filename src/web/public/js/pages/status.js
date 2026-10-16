import { get, post } from '../api.js';
import { html, icon, num, ago, dateTime, duration, toast, confirmDialog, withBusy } from '../ui.js';
import { setTitle, state } from '../main.js';

let ctxRef = null;
let timer = null;
let loadingCtx = null;

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const KIND = { discord: 'Discord', simulator: 'Simulador (sin Discord)', offline: 'Desconectado' };

async function load() {
  const ctx = ctxRef;
  if (!ctx || loadingCtx === ctx) return;
  loadingCtx = ctx;
  let s;
  try { s = await get('/status'); } finally { if (loadingCtx === ctx) loadingCtx = null; }
  if (!ctx.isCurrent() || ctxRef !== ctx) return;
  state.status = s;
  const b = s.bot;
  const heapPct = Math.round((s.memory.heapUsed / s.memory.heapTotal) * 100);
  const logScroll = ctx.view.querySelector('.log-box')?.scrollTop || 0;
  ctx.view.innerHTML = String(html`
    <div class="grid status-grid">
      <div class="card"><div class="card-head"><h2>Bot de Discord</h2><div class="right"><span class="badge ${b.online ? (b.kind === 'simulator' ? 'violet' : 'success') : 'danger'}"><span class="dot"></span>${b.online ? 'En línea' : 'Desconectado'}</span></div></div>
        <div class="card-body"><dl class="dl">
          <dt>Modo</dt><dd>${KIND[b.kind]}</dd>
          ${b.user ? html`<dt>Cuenta</dt><dd data-i18n-ignore>${b.user.tag || b.user.username}</dd>` : ''}
          ${b.user?.id ? html`<dt>ID de aplicación</dt><dd><code>${b.user.id}</code></dd>` : ''}
          <dt>Servidores</dt><dd>${num(b.guilds ?? 0)}</dd>
          ${b.kind === 'discord' ? html`<dt>Latencia</dt><dd>${b.ping >= 0 ? `${b.ping} ms` : '—'}</dd><dt>Intent de miembros</dt><dd>${b.membersIntent ? html`<span class="badge success">Activo</span>` : html`<span class="badge warning">Desactivado</span>`}</dd>` : ''}
          ${b.error ? html`<dt>Error</dt><dd style="color:var(--danger)">${b.error}</dd>` : ''}
        </dl>
        ${b.intentStatus ? html`<p class="small muted">Portal de Discord: ${b.intentStatus.portalEnabled === true ? 'Activado' : b.intentStatus.portalEnabled === false ? 'Desactivado' : 'Sin comprobar'} · ${b.intentStatus.checkedAt ? ago(b.intentStatus.checkedAt) : 'Comprobando…'}</p>${b.intentStatus.error ? html`<p class="small muted">${b.intentStatus.error}</p>` : ''}` : ''}
        ${b.kind === 'discord' && state.session?.user?.owner ? html`<button class="btn sm mt" data-act="refreshIntent">${icon('refresh')} Comprobar intent</button>` : ''}
        <div class="row mt"><button class="btn sm" data-act="invite">${icon('plus')} Invitar a un servidor</button><a class="btn sm" href="/docs/guia.html" target="_blank">${icon('book')} Guía</a></div></div></div>

      <div class="card"><div class="card-head"><h2>Sistema</h2></div><div class="card-body"><dl class="dl">
        <dt>Versión</dt><dd>v${s.version} · Node ${s.node}</dd>
        <dt>Encendido</dt><dd>${duration(s.uptimeSec * 1000)} <span class="muted">(desde ${dateTime(s.startedAt)})</span></dd>
        <dt>Memoria (RSS)</dt><dd>${mb(s.memory.rss)}</dd>
        <dt>Heap</dt><dd><div class="meter-row"><div class="progress"><span style="width:${heapPct}%"></span></div><span class="small">${mb(s.memory.heapUsed)} / ${mb(s.memory.heapTotal)}</span></div></dd>
        <dt>Paneles en vivo</dt><dd>${num(s.live)} conexión(es)</dd>
        ${s.dataDir ? html`<dt>Datos</dt><dd><code class="small">${s.dataDir}</code></dd>` : ''}
      </dl></div></div>

      <div class="card providers-card"><div class="card-head"><h2>Fuentes de X (sin API)</h2></div><div class="card-body">
        <p class="small muted" style="margin-top:0">El bot lee datos públicos de X con varias fuentes y cambia de una a otra si alguna falla.</p>
        <div class="stack" style="gap:10px">${s.x.providers.map(
          (p) => html`<div class="provider-row"><div><strong>${p.name}</strong><div class="small muted">${p.ok} ok · ${p.fail} fallos${p.lastOk ? ` · último ok ${ago(p.lastOk)}` : ''}</div>${p.lastError ? html`<div class="small muted" title="${dateTime(p.lastErrorAt)}">Último error: ${p.lastError}</div>` : ''}${p.paused?.length ? html`<div class="small">Reintentos desde: ${dateTime(Math.max(...p.paused.map((x) => x.until)))}</div>` : ''}</div>
            <span class="badge ${p.state === 'ok' ? 'success' : p.state === 'untested' ? '' : 'warning'}">${{ rate_limited: 'En pausa por límite de X', retry_ready: 'Listo para reintentar', untested: 'Sin comprobar', unavailable: 'No disponible temporalmente', ok: 'OK' }[p.state] || 'Sin comprobar'}</span></div>`,
        )}</div>
        <p class="small muted">Caché: ${num(s.x.cacheSize)} elementos · en curso: ${num(s.x.inflight)} · en cola: ${num(s.x.queued)}</p>
      </div></div>
    </div>

    ${s.logs.length
      ? html`<div class="card mt"><div class="card-head"><h2>Registro reciente</h2><div class="sub">Últimas líneas del log (se guarda completo en data/logs/app.log)</div></div><div class="card-body"><div class="log-box">${s.logs
          .slice()
          .reverse()
          .map((l) => html`<div class="${l.level}">[${new Date(l.t).toLocaleTimeString(document.documentElement.lang)}] ${l.level.toUpperCase()} [${l.scope}] <span data-i18n-ignore>${l.msg}</span></div>`)}</div></div></div>`
      : ''}

    ${state.session?.user?.owner
      ? html`<div class="card mt"><div class="card-head"><h2>Seguridad</h2></div><div class="card-body row between"><span class="small muted">Cierra todas las sesiones abiertas del panel (incluida esta). Útil si cambiaste la contraseña o compartiste el acceso.</span><button class="btn sm danger" data-act="revoke">${icon('logout')} Cerrar todas las sesiones</button></div></div>`
      : ''}`);
  const logs = ctx.view.querySelector('.log-box');
  if (logs) { logs.scrollTop = logScroll; logs.tabIndex = 0; logs.setAttribute('role', 'log'); logs.setAttribute('aria-label', 'Registro reciente'); }
}

export default {
  async render(ctx) {
    ctxRef = ctx;
    setTitle('Estado del bot', 'Conexión, memoria y fuentes de datos');
    await load();
    if (ctxRef !== ctx || !ctx.isCurrent()) return;
    clearInterval(timer);
    timer = setInterval(() => load().catch(() => {}), 10_000);
  },
  destroy() {
    clearInterval(timer);
    ctxRef = null;
  },
  onLocale: load,
  actions: {
    async refreshIntent(el) {
      await withBusy(el, async () => {
        await post('/discord/intents/refresh');
        await load();
        window.dispatchEvent(new Event('engage:status'));
      });
    },
    async invite() {
      const r = await get('/invite');
      if (r.url) window.open(r.url, '_blank', 'noopener');
      else toast('Disponible cuando el bot esté conectado a Discord.', 'info');
    },
    async revoke() {
      if (!(await confirmDialog({ title: 'Cerrar todas las sesiones', message: 'Todos (incluido tú) tendrán que volver a iniciar sesión.', confirmLabel: 'Cerrar sesiones', danger: true }))) return;
      await post('/sessions/revoke');
      location.reload();
    },
  },
};
