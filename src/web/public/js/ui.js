// Utilidades de interfaz: plantillas seguras, iconos, avisos, diálogos, formatos y gráficos.
import { getLocale, getLanguage, t } from './i18n.js';

// ─── Plantillas con escape automático (evita XSS) ────────────────
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s ?? ''));
const renderVal = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  return esc(v);
};
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += renderVal(vals[i]);
  });
  return new Raw(out);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ─── Iconos (trazos propios, estilo línea) ───────────────────────
const P = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7"/><path d="M18 14.8c1.9.7 3.1 2.5 3.5 5.2"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 01-8 0z"/><path d="M8 6H4v1a4 4 0 004 4"/><path d="M16 6h4v1a4 4 0 01-4 4"/><path d="M12 13v4"/><path d="M8 20h8"/><path d="M10 17h4v3h-4z"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6l-5.5 9A2 2 0 006.2 21h11.6a2 2 0 001.7-3L14 9V3"/><path d="M7.5 15h9"/>',
  book: '<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5"/><path d="M8 7h7"/>',
  logout: '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 16l-4-4 4-4"/><path d="M6 12h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 6.3"/><path d="M20 4v7h-7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a4.8 4.8 0 019-3 4.8 4.8 0 019 3c-2 4.6-9 9-9 9z"/>',
  repeat: '<path d="M4 9V8a3 3 0 013-3h11"/><path d="M15 2l3 3-3 3"/><path d="M20 15v1a3 3 0 01-3 3H6"/><path d="M9 22l-3-3 3-3"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  quote: '<path d="M4 5h16v11H9l-5 4z"/><path d="M9 9h6M9 12h4"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  bell: '<path d="M6 9a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 004 0"/>',
  send: '<path d="M21 3L10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.2-7 8-7s7 2.5 8 7"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  fast: '<path d="M4 6l8 6-8 6z"/><path d="M12 6l8 6-8 6z"/>',
  star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.2L12 17.4l-5.5 2.9 1-6.2L3 9.7l6.2-.9z"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3L8 21M16 3l-2 18"/>',
  xlogo: '<path d="M4 4l16 16M20 4L4 20" stroke-width="2.4"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.info}</svg>`);

// ─── Formatos ─────────────────────────────────────────────────────
const formats = Object.fromEntries(['es', 'en'].map((lang) => [lang, {
  nf: new Intl.NumberFormat(lang),
  nfc: new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }),
  rtf: new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }),
  dtf: new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }),
}]));
export const num = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : formats[getLanguage()].nf.format(Number(n)));
export const compact = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : formats[getLanguage()].nfc.format(Number(n)));
export function ago(ms) {
  if (!ms) return '—';
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const { rtf } = formats[getLanguage()];
  if (abs < 45) return getLanguage() === 'en' ? (diff < 0 ? 'just now' : 'in a few seconds') : (diff < 0 ? 'hace un momento' : 'en unos segundos');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return dateTime(ms);
}
export const dateTime = (ms) => (ms ? formats[getLanguage()].dtf.format(new Date(ms)) : '—');
export function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return [d ? `${d} d` : '', h ? `${h} h` : '', mm || (!d && !h) ? `${mm} min` : ''].filter(Boolean).join(' ');
}
export const initials = (name) =>
  String(name || '?')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';

export function avatar(url, name, cls = '') {
  if (url) return html`<img class="avatar ${cls}" src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  return html`<span class="avatar ${cls}" aria-hidden="true">${initials(name)}</span>`;
}

export const ACTIONS = {
  like: { label: 'Like', emoji: '❤️', icon: 'heart' },
  repost: { label: 'Repost', emoji: '🔁', icon: 'repeat' },
  reply: { label: 'Comentario', emoji: '💬', icon: 'message' },
  quote: { label: 'Cita', emoji: '🗨️', icon: 'quote' },
};
export const STATUS = {
  verified: { label: 'Hecho', cls: 'success' },
  pending: { label: 'En revisión', cls: 'warning' },
  awaiting: { label: 'Falta captura', cls: 'warning' },
  rejected: { label: 'Rechazado', cls: 'danger' },
  revoked: { label: 'Anulado', cls: 'danger' },
  none: { label: 'Pendiente', cls: '' },
};
export const STATE = {
  complete: { label: 'Completó', cls: 'success' },
  pending: { label: 'En revisión', cls: 'warning' },
  partial: { label: 'Incompleta', cls: 'danger' },
  none: { label: 'No participó', cls: '' },
};
export const METHOD = {
  auto: 'Comprobado en X',
  timeline: 'Visto en su perfil',
  declared: 'Declarado',
  screenshot: 'Captura',
  manual: 'Staff',
};
export const TASK_STATUS = {
  active: { label: 'Activa', cls: 'info' },
  closed: { label: 'Finalizada', cls: '' },
  cancelled: { label: 'Cancelada', cls: 'danger' },
};
export const actionIcons = (actions) => html`<span class="act-icons">${actions.map((a) => html`<span class="act" title="${ACTIONS[a]?.label}">${ACTIONS[a]?.emoji}</span>`)}</span>`;

/** Convierte "<@123>" en chips con nombre. */
export function withMentions(text, users = {}) {
  const parts = String(text ?? '').split(/(<@!?\d{5,25}>)/g);
  return raw(
    parts
      .map((p) => {
        const m = p.match(/^<@!?(\d{5,25})>$/);
        if (!m) return esc(p);
        const name = users[m[1]];
        return `<span class="mention">@${esc(name || 'usuario')}</span>`;
      })
      .join(''),
  );
}

// ─── Avisos (toasts) ─────────────────────────────────────────────
export function toast(message, type = 'info', ms = 4200) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = String(html`${icon(type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info')}<div>${message}</div>`);
  box.appendChild(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => el.remove(), ms);
}

// ─── Diálogos ────────────────────────────────────────────────────
/**
 * Abre un diálogo. `body` es HTML (Raw). `onSubmit(form)` puede devolver false para no cerrar.
 * Devuelve una promesa que se resuelve con el valor de onSubmit o null si se cancela.
 */
export function modal({ title, body, submitLabel = 'Guardar', cancelLabel = 'Cancelar', danger = false, wide = false, onSubmit = null, hideSubmit = false }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = String(html`
      <form class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}" novalidate>
        <div class="modal-head"><h3>${title}</h3><button type="button" class="icon-btn" data-close aria-label="Cerrar">${icon('x')}</button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-close>${cancelLabel}</button>
          ${hideSubmit ? '' : html`<button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${submitLabel}</button>`}
        </div>
      </form>`);
    const form = back.querySelector('form');
    const prevFocus = document.activeElement;
    let closed = false;
    const close = (value) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      back.remove();
      prevFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) close(null);
    });
    back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(true);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      const old = btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span>';
      try {
        const r = await onSubmit(form);
        if (r !== false) close(r ?? true);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        if (!closed) {
          btn.disabled = false;
          btn.innerHTML = old;
        }
      }
      return undefined;
    });
    root.appendChild(back);
    (form.querySelector('input,select,textarea,button[type=submit]') || form).focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  return modal({ title, body: html`<p style="margin:0">${message}</p>`, submitLabel: confirmLabel, danger }).then(Boolean);
}

export async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.disabled) return undefined;
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>${btn.classList.contains('icon-btn') ? '' : ' Procesando…'}`;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

export function emptyState(iconName, title, text, action = '') {
  return html`<div class="empty"><div class="big">${icon(iconName)}</div><h3>${title}</h3><p>${text}</p>${action}</div>`;
}

// ─── Gráficos ────────────────────────────────────────────────────
const tip = () => $('#chart-tip');
export function showTip(e, htmlContent) {
  const t = tip();
  t.innerHTML = String(htmlContent);
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export function hideTip() {
  tip().hidden = true;
}

/** Escala "bonita": paso de 1/2/5×10ⁿ y máximo múltiplo del paso (ticks siempre enteros). */
function niceScale(v, target = 4) {
  const raw = Math.max(1, v) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const max = step * Math.max(1, Math.ceil(v / step));
  return { max, ticks: Math.round(max / step) };
}

/**
 * Gráfico de columnas de una serie. data: [{label, value, tip}]
 * Barras finas (≤24px), extremo redondeado de 4px, rejilla fina y tooltip por barra.
 */
export function columnChart(data, { width = 640, height = 220, unit = '', valueLabel = (v) => num(v), labelEvery = 0, maxValue = null, showMaxLabel = true } = {}) {
  const W = Math.max(260, Math.round(width));
  const H = height;
  const m = { t: 18, r: 8, b: 26, l: 34 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const scale = maxValue ? { max: maxValue, ticks: 4 } : niceScale(Math.max(1, ...data.map((d) => d.value)));
  const max = scale.max;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.6);
  const every = labelEvery || Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(iw / 44))));
  const ticks = scale.ticks;
  let s = `<svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
  for (let i = 0; i <= ticks; i++) {
    const y = m.t + ih - (ih * i) / ticks;
    s += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`;
    s += `<text class="axis-text" x="${m.l - 6}" y="${y + 4}" text-anchor="end">${esc(valueLabel((max * i) / ticks))}${esc(unit)}</text>`;
  }
  const maxIdx = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? -1) ? i : best), 0);
  data.forEach((d, i) => {
    const cx = m.l + band * i + band / 2;
    const h = max ? (ih * d.value) / max : 0;
    const x = cx - bw / 2;
    const y = m.t + ih - h;
    const r = Math.min(4, h / 2, bw / 2);
    const path = h > 0 ? `M${x},${m.t + ih} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${m.t + ih} Z` : '';
    s += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}" tabindex="0"/>`;
    if (path) s += `<path class="bar" data-bar="${i}" d="${path}"/>`;
    if (i % every === 0) s += `<text class="axis-text" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    if (showMaxLabel && i === maxIdx && d.value > 0) s += `<text class="label-text" x="${cx}" y="${y - 6}" text-anchor="middle">${esc(valueLabel(d.value))}${esc(unit)}</text>`;
  });
  s += '</svg>';
  return raw(s);
}

/** Conecta los tooltips de un gráfico de columnas ya insertado en el DOM. */
export function bindColumnTips(container, data) {
  const svg = container?.querySelector('svg.chart');
  if (!svg) return;
  const onMove = (e) => {
    const i = e.target?.dataset?.i;
    svg.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
    if (i === undefined) return hideTip();
    svg.querySelector(`[data-bar="${i}"]`)?.classList.add('hover');
    const d = data[Number(i)];
    showTip(e, d.tip || html`<div class="tv">${num(d.value)}</div><div class="tl">${d.label}</div>`);
    return undefined;
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerleave', () => {
    hideTip();
    svg.querySelectorAll('.bar.hover').forEach((b) => b.classList.remove('hover'));
  });
  svg.addEventListener('focusin', (e) => {
    const r = e.target.getBoundingClientRect();
    onMove({ target: e.target, clientX: r.left + r.width / 2, clientY: r.top });
  });
  svg.addEventListener('focusout', hideTip);
}

// Gráficos que se redibujan al cambiar el ancho. Se liberan al cambiar de página.
const observers = new Set();
export function mountColumnChart(el, data, opts = {}) {
  if (!el) return;
  let lastW = 0;
  const draw = () => {
    const w = el.clientWidth;
    if (!w || Math.abs(w - lastW) < 4) return;
    lastW = w;
    el.innerHTML = String(columnChart(data, { ...opts, width: w }));
    bindColumnTips(el, data);
  };
  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(el);
  observers.add(ro);
}
export function disposeCharts() {
  for (const ro of observers) ro.disconnect();
  observers.clear();
  hideTip();
}
