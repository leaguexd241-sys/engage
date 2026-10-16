// Renderiza mensajes con el formato JSON de la API de Discord (el mismo que envía el bot).
import { esc, raw, html, icon } from './ui.js';

const tsFmt = {
  t: { timeStyle: 'short' },
  T: { timeStyle: 'medium' },
  d: { dateStyle: 'short' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
};
const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

function relative(ms) {
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

function timestamp(unix, style = 'f') {
  const ms = Number(unix) * 1000;
  const text = style === 'R' ? relative(ms) : new Intl.DateTimeFormat('es-ES', tsFmt[style] || tsFmt.f).format(new Date(ms));
  return `<span class="dc-ts" title="${esc(new Date(ms).toLocaleString('es-ES'))}">${esc(text)}</span>`;
}

const safeUrl = (u) => {
  const s = String(u || '').replace(/&amp;/g, '&');
  return /^https?:\/\//i.test(s) ? esc(s) : null;
};

/** Markdown de Discord (subconjunto) → HTML seguro. ctx: {users, roles, channels} */
export function markdown(text, ctx = {}) {
  if (!text) return '';
  const holds = [];
  const hold = (h) => `\u0000${holds.push(h) - 1}\u0000`;
  let s = String(text);
  // 1) Escapes con barra invertida
  s = s.replace(/\\([^\w\s])/g, (_, c) => hold(esc(c)));
  // 2) Escape HTML
  s = esc(s);
  // 3) Código en línea
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code class="dc-code">${c}</code>`));
  // 4) Menciones y marcas de tiempo
  s = s.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => hold(`<span class="dc-mention">@${esc(ctx.users?.[id] || 'usuario')}</span>`));
  s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
    const r = ctx.roles?.[id];
    return hold(`<span class="dc-mention"${r?.color && r.color !== '#000000' ? ` style="color:${esc(r.color)};background:${esc(r.color)}22"` : ''}>@${esc(r?.name || 'rol')}</span>`);
  });
  s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => hold(`<span class="dc-mention">#${esc(ctx.channels?.[id] || 'canal')}</span>`));
  s = s.replace(/&lt;t:(\d+)(?::([tTdDfFR]))?&gt;/g, (_, t, st) => hold(timestamp(t, st || 'f')));
  // 5) Enlaces con texto [texto](url)
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
    const u = safeUrl(url);
    return u ? hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${label}</a>`) : m;
  });
  // 6) Enlaces sueltos
  s = s.replace(/https?:\/\/[^\s<\u0000]+[^\s<\u0000.,;:!?)'"]/g, (url) => {
    const u = safeUrl(url);
    return u ? hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${url}</a>`) : url;
  });
  // 7) Estilos
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+?)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  // 8) Citas (líneas que empiezan por "> ")
  const lines = s.split('\n');
  const out = [];
  let quote = [];
  const flush = () => {
    if (quote.length) out.push(`<div class="dc-quote"><div>${quote.join('\n')}</div></div>`);
    quote = [];
  };
  for (const line of lines) {
    const m = line.match(/^&gt; ?(.*)$/);
    if (m) quote.push(m[1]);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  s = out.join('\n').replace(/<\/div><\/div>\n/g, '</div></div>');
  // 9) Restaurar lo reservado
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => holds[Number(i)]);
  return s;
}

const hexColor = (n) => (Number.isInteger(n) ? `#${n.toString(16).padStart(6, '0')}` : '#1e1f22');

function renderEmbed(e, ctx) {
  const parts = [];
  if (e.author?.name) {
    const name = e.author.url ? `<a href="${safeUrl(e.author.url) || '#'}" target="_blank" rel="noopener noreferrer" style="color:inherit">${esc(e.author.name)}</a>` : esc(e.author.name);
    parts.push(`<div class="dc-embed-author">${e.author.icon_url ? `<img src="${esc(e.author.icon_url)}" alt="" referrerpolicy="no-referrer">` : ''}${name}</div>`);
  }
  if (e.title) {
    const t = markdown(e.title, ctx);
    parts.push(`<div class="dc-embed-title">${e.url && safeUrl(e.url) ? `<a href="${safeUrl(e.url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : t}</div>`);
  }
  if (e.description) parts.push(`<div class="dc-embed-desc">${markdown(e.description, ctx)}</div>`);
  if (e.fields?.length) {
    parts.push(
      `<div class="dc-fields">${e.fields
        .map((f) => `<div class="dc-field ${f.inline ? 'inline' : ''}"><div class="dc-field-name">${markdown(f.name, ctx)}</div><div class="dc-field-value">${markdown(f.value, ctx)}</div></div>`)
        .join('')}</div>`,
    );
  }
  if (e.image?.url) parts.push(`<img class="dc-embed-image" src="${esc(e.image.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`);
  if (e.footer?.text || e.timestamp) {
    const when = e.timestamp ? new Date(e.timestamp).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '';
    parts.push(`<div class="dc-embed-footer">${esc(e.footer?.text || '')}${e.footer?.text && when ? ' • ' : ''}${esc(when)}</div>`);
  }
  if (e.thumbnail?.url) parts.push(`<img class="dc-thumb" src="${esc(e.thumbnail.url)}" alt="" referrerpolicy="no-referrer">`);
  return `<div class="dc-embed" style="border-left-color:${hexColor(e.color)}">${parts.join('')}</div>`;
}

function renderComponents(rows, messageId, { interactive = true } = {}) {
  if (!rows?.length) return '';
  return `<div class="dc-components">${rows
    .map(
      (r) =>
        `<div class="dc-row">${(r.components || [])
          .map((b) => {
            const label = `${b.emoji?.name ? `<span>${esc(b.emoji.name)}</span>` : ''}${b.label ? `<span>${esc(b.label)}</span>` : ''}`;
            if (b.style === 5) {
              return `<a class="dc-btn s5" href="${safeUrl(b.url) || '#'}" target="_blank" rel="noopener noreferrer" title="${esc(b.url)}">${label}<svg class="i ext" viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg></a>`;
            }
            return `<button type="button" class="dc-btn s${b.style}" ${interactive ? `data-act="dcButton" data-cid="${esc(b.custom_id)}" data-mid="${esc(messageId || '')}"` : 'disabled'} ${b.disabled ? 'disabled' : ''}>${label}</button>`;
          })
          .join('')}</div>`,
    )
    .join('')}</div>`;
}

/**
 * Renderiza un mensaje.
 * msg: {id, author:{name, avatar, bot}, content, embeds, components, createdAt, editedAt, ephemeralFor, interaction}
 */
export function renderMessage(msg, ctx = {}, opts = {}) {
  const a = msg.author || { name: 'Engage Bot', bot: true };
  const when = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : 'hoy';
  const avatar = a.avatar ? `<img src="${esc(a.avatar)}" alt="" referrerpolicy="no-referrer">` : `<img src="/img/logo.svg" alt="">`;
  const ref = msg.interaction
    ? `<div class="dc-reply-ref"><span>↱</span><strong>${esc(msg.interaction.user?.name || 'usuario')}</strong> usó <span style="color:var(--dc-link)">${esc(msg.interaction.command)}</span></div>`
    : '';
  return raw(`
    <div class="dc-msg ${msg.ephemeralFor ? 'ephemeral' : ''}" data-mid="${esc(msg.id || '')}">
      ${ref}
      <div class="dc-avatar">${avatar}</div>
      <div class="dc-head"><span class="dc-name">${esc(a.name)}</span>${a.bot ? '<span class="dc-bot">✓ App</span>' : ''}<span class="dc-time">${esc(when)}</span>${msg.editedAt ? '<span class="dc-edited">(editado)</span>' : ''}</div>
      <div>
        ${msg.content ? `<div class="dc-content">${markdown(msg.content, ctx)}</div>` : ''}
        ${(msg.embeds || []).map((e) => renderEmbed(e, ctx)).join('')}
        ${renderComponents(msg.components, msg.id, opts)}
        ${msg.ephemeralFor ? '<div class="dc-ephemeral-note">👁️ Solo tú puedes ver esto</div>' : ''}
      </div>
    </div>`);
}

/** Vista previa de un payload (sin interacción). */
export function renderPayload(payload, ctx = {}) {
  return html`<div class="dc" style="padding:8px 0">${renderMessage({ id: 'preview', author: { name: 'Engage Bot', bot: true }, ...payload, createdAt: Date.now() }, ctx, { interactive: false })}</div>`;
}

export { icon };
