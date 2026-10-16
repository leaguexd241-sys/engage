'use strict';

/**
 * Constructores de mensajes de Discord (formato JSON de la API).
 * Todo lo que se muestra al usuario sale de aquí, así el bot real y el simulador se ven igual.
 */

const { ACTION_INFO, colorInt } = require('../core/settings');
const { trustLevel } = require('../core/trust');
const { intents, profileUrl } = require('../twitter/urls');
const { truncate, escapeMd, quoteBlock, progressBar, fmtNum, fmtCompact, pct } = require('../util/text');
const { discordTs, formatDuration } = require('../util/time');

const EPHEMERAL = 64;
const COLORS = {
  ok: 0x57f287,
  warn: 0xfee75c,
  error: 0xed4245,
  info: 0x5865f2,
  grey: 0x4f545c,
  x: 0x1d9bf0,
  gold: 0xf1c40f,
};
const BUTTON = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
const STATUS_ICON = {
  verified: '✅',
  already: '✅',
  pending: '🕓',
  awaiting: '📸',
  rejected: '❌',
  revoked: '🚫',
  none: '⬜',
  missing: '✏️',
  error: '⚠️',
};
const METHOD_LABEL = {
  auto: 'comprobado en X',
  timeline: 'visto en tu perfil',
  declared: 'declarado',
  screenshot: 'con captura',
  manual: 'marcado por el staff',
};

// ─── Utilidades de formato ───────────────────────────────────────
function field(name, value, inline = false) {
  const v = String(value ?? '').trim();
  return { name: truncate(String(name), 256) || '​', value: truncate(v || '—', 1024), inline };
}

function embed(e) {
  const out = { ...e };
  if (out.title) out.title = truncate(out.title, 256);
  if (out.description) out.description = truncate(out.description, 4096);
  if (out.footer?.text) out.footer = { ...out.footer, text: truncate(out.footer.text, 2048) };
  if (out.author?.name) out.author = { ...out.author, name: truncate(out.author.name, 256) };
  if (out.fields) out.fields = out.fields.slice(0, 25);
  return out;
}

function row(...components) {
  return { type: 1, components: components.filter(Boolean).slice(0, 5) };
}

function button({ id, label, style = 'secondary', emoji, url, disabled = false }) {
  const b = { type: 2, style: url ? BUTTON.link : BUTTON[style], label: truncate(label, 80) };
  if (emoji) b.emoji = { name: emoji };
  if (url) b.url = url;
  else b.custom_id = id;
  if (disabled) b.disabled = true;
  return b;
}

/** Lista de menciones que cabe en `max` caracteres, con "… y N más". */
function mentionList(users, max = 1000, fmt = (u) => `<@${u.id}>`) {
  if (!users.length) return '—';
  const parts = [];
  let len = 0;
  for (let i = 0; i < users.length; i++) {
    const s = fmt(users[i]);
    const rest = users.length - i;
    const suffix = rest > 1 ? ` … y ${rest} más` : '';
    if (len + s.length + 2 + suffix.length > max) {
      parts.push(`… y ${rest} más`);
      break;
    }
    parts.push(s);
    len += s.length + 2;
  }
  return parts.join(', ').replace(', …', ' …');
}

function actionsLine(actions) {
  return actions.map((a) => `${ACTION_INFO[a].emoji} ${ACTION_INFO[a].label}`).join(' · ');
}

function taskPoints(task) {
  const base = task.actions.reduce((s, a) => s + (task.points[a] || 0), 0);
  return { base, bonus: task.points.bonus || 0, total: base + (task.points.bonus || 0) };
}

function messageUrl(guildId, channelId, messageId) {
  return guildId && channelId && messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null;
}

function ephemeral(payload) {
  return { ...payload, flags: EPHEMERAL };
}

function errorMessage(text, { title = 'No se pudo completar' } = {}) {
  return ephemeral({ embeds: [embed({ color: COLORS.error, title: `❌ ${title}`, description: text })], components: [] });
}

function successMessage(text, { title = 'Listo' } = {}) {
  return ephemeral({ embeds: [embed({ color: COLORS.ok, title: `✅ ${title}`, description: text })], components: [] });
}

function infoMessage(text, { title = null, color = COLORS.info } = {}) {
  return ephemeral({ embeds: [embed({ color, title: title || undefined, description: text })], components: [] });
}

// ─── Mensaje público de la tarea ────────────────────────────────
function taskMessage(task, view) {
  const t = task.tweet || {};
  const author = t.author || {};
  const settings = view.settings;
  const active = task.status === 'active';
  const pts = taskPoints(task);
  const statusText = active ? 'Activa' : task.status === 'closed' ? 'Finalizada' : 'Cancelada';
  const color = active ? colorInt(settings?.embedColor) : task.status === 'closed' ? COLORS.grey : COLORS.error;

  const base = view.expectedCount ?? null;
  const progress =
    base !== null && base > 0
      ? `${progressBar(view.completed / base)}  **${view.completed}/${base}** completaron (${pct(view.completed, base)}%)`
      : `**${view.completed}** completaron · **${view.participants}** participando`;

  const steps = ['**1.** Pulsa los botones para hacer cada acción en X.', '**2.** Vuelve aquí y pulsa **✅ Ya lo hice**.'];
  if (task.actions.includes('reply') || task.actions.includes('quote')) {
    steps.push(`**3.** Pega el enlace de tu ${task.actions.includes('reply') ? 'comentario' : 'cita'} cuando el bot te lo pida.`);
  }

  let description = quoteBlock(t.text || '(post sin texto)', 700);
  if (t.media?.length > 1) description += `\n*+${t.media.length - 1} archivo(s) más en el post*`;
  if (task.note) description += `\n\n📝 **Nota del staff:** ${escapeMd(truncate(task.note, 500))}`;

  const fields = [];
  if (active) fields.push(field('🎯 Qué hacer', steps.join('\n')));
  fields.push(
    field(active ? '⏰ Termina' : '⏰ Terminó', `${discordTs(active ? task.endsAt : task.closedAt || task.endsAt, 'R')}\n${discordTs(active ? task.endsAt : task.closedAt || task.endsAt, 'f')}`, true),
    field('🏆 Recompensa', `**${pts.total} pts**${pts.bonus ? `\n(${pts.base} + ${pts.bonus} de bonus)` : ''}`, true),
    field('📊 Progreso', progress),
  );

  const image = t.media?.find((m) => m.url)?.url;
  const e = embed({
    color,
    author: author.handle
      ? { name: `${author.name || author.handle} (@${author.handle})`, url: profileUrl(author.handle), icon_url: author.avatar || undefined }
      : undefined,
    title: `${active ? '🚀' : task.status === 'closed' ? '🏁' : '⛔'} Tarea #${task.id} · ${actionsLine(task.actions)}`,
    url: task.tweetUrl,
    description,
    fields,
    image: image ? { url: image } : undefined,
    footer: { text: `${statusText} · ID ${task.id} · Verificación sin API de X` },
    timestamp: new Date(task.createdAt).toISOString(),
  });

  const components = [];
  if (active) {
    const links = task.actions.map((a) => {
      if (a === 'like') return button({ label: 'Like', emoji: '❤️', url: intents.like(task.tweetId) });
      if (a === 'repost') return button({ label: 'Repostear', emoji: '🔁', url: intents.repost(task.tweetId) });
      if (a === 'reply') return button({ label: 'Comentar', emoji: '💬', url: intents.reply(task.tweetId) });
      return button({ label: 'Citar', emoji: '🗨️', url: intents.quote(task.tweetId, author.handle) });
    });
    links.push(button({ label: 'Abrir post', emoji: '🔗', url: task.tweetUrl }));
    components.push(row(...links));
    components.push(
      row(
        button({ id: `eng:verify:${task.id}`, label: 'Ya lo hice', style: 'success', emoji: '✅' }),
        button({ id: `eng:progress:${task.id}`, label: 'Mi progreso', emoji: '📋' }),
        button({ id: `eng:status:${task.id}`, label: 'Quién falta', emoji: '👥' }),
      ),
    );
  } else {
    components.push(
      row(
        button({ id: `eng:status:${task.id}`, label: task.status === 'closed' ? 'Ver resultados' : 'Ver participación', emoji: '📊' }),
        button({ label: 'Abrir post', emoji: '🔗', url: task.tweetUrl }),
      ),
    );
  }

  // Al editar no se toca el texto (así la mención del primer envío se conserva).
  const content = active && task.pingRoleId && !task.messageId ? `<@&${task.pingRoleId}> ¡Nueva tarea de engagement! 🚀` : undefined;
  return {
    content,
    embeds: [e],
    components,
    allowedMentions: { roles: task.pingRoleId ? [task.pingRoleId] : [], users: [], parse: [] },
  };
}

// ─── Progreso de un usuario (efímero) ───────────────────────────
function progressMessage(task, progress, { results = null, completedNow = false, pointsEarned = null } = {}) {
  const resultBy = new Map((results || []).map((r) => [r.action, r]));
  const lines = progress.items.map((item) => {
    const r = resultBy.get(item.action);
    const status = r ? r.state : item.status;
    const info = ACTION_INFO[item.action];
    let detail;
    if (r) detail = r.message;
    else if (item.status === 'verified') detail = `Hecho (${METHOD_LABEL[item.sub?.method] || 'verificado'})${item.sub?.quality != null ? ` · calidad ${item.sub.quality}/100` : ''}`;
    else if (item.status === 'pending') detail = 'En revisión por el staff';
    else if (item.status === 'awaiting') detail = `Falta tu captura: \`/prueba tarea:${task.id} accion:${item.action}\``;
    else if (item.status === 'rejected' || item.status === 'revoked') detail = item.sub?.reason || 'Rechazado';
    else detail = 'Pendiente';
    return `${STATUS_ICON[status] || '⬜'} **${info.emoji} ${info.label}** — ${detail}`;
  });

  const anyRejected = (results || []).some((r) => r.state === 'rejected' || r.state === 'error' || r.state === 'missing');
  let color = COLORS.info;
  let title = `📋 Tu progreso en la tarea #${task.id}`;
  if (completedNow) {
    color = COLORS.ok;
    title = '🎉 ¡Tarea completada!';
  } else if (progress.complete) {
    color = COLORS.ok;
    title = `✅ Tarea #${task.id} completada`;
  } else if (anyRejected) {
    color = COLORS.error;
    title = `⚠️ Tarea #${task.id}: falta algo`;
  } else if (progress.state === 'pending') {
    color = COLORS.warn;
    title = `🕓 Tarea #${task.id}: en revisión`;
  }

  const fields = [field('Progreso', `${progressBar(progress.done / (progress.total || 1), 10)}  **${progress.done}/${progress.total}**`, true)];
  if (pointsEarned !== null) fields.push(field('Puntos en esta tarea', `**${fmtNum(pointsEarned)}**`, true));

  const components = [];
  const open = task.status === 'active' && task.endsAt > Date.now();
  if (open && !progress.complete && progress.state !== 'pending') {
    components.push(row(button({ id: `eng:verify:${task.id}`, label: anyRejected ? 'Reintentar' : 'Ya lo hice', style: 'success', emoji: '✅' })));
  }
  return ephemeral({
    embeds: [
      embed({
        color,
        title,
        url: task.tweetUrl,
        description: lines.join('\n'),
        fields,
        footer: open && !progress.complete ? { text: 'Si algo falló, corrígelo en X y vuelve a pulsar ✅' } : undefined,
      }),
    ],
    components,
  });
}

// ─── Quién hizo y quién no ──────────────────────────────────────
function summaryFields(summary) {
  const fmtPartial = (u) => `<@${u.id}> (${u.done}/${u.total})`;
  const fields = [field(`✅ Completaron (${summary.completed.length})`, mentionList(summary.completed))];
  if (summary.pending.length) fields.push(field(`🕓 En revisión (${summary.pending.length})`, mentionList(summary.pending)));
  if (summary.partial.length) fields.push(field(`⚠️ Incompleta (${summary.partial.length})`, mentionList(summary.partial, 1000, fmtPartial)));
  if (summary.expectedCount !== null) fields.push(field(`❌ No participaron (${summary.missing.length})`, mentionList(summary.missing)));
  return fields;
}

function expectedNote(task, summary) {
  if (summary.expectedSource === 'role') return `Se esperaba la participación del rol <@&${task.roleId}> (${fmtNum(summary.expectedCount)} miembros).`;
  if (summary.expectedSource === 'linked') return `Se compara con los ${fmtNum(summary.expectedCount)} miembros que tienen su cuenta de X vinculada.`;
  return '';
}

function statusMessage(task, summary) {
  const active = task.status === 'active';
  return ephemeral({
    embeds: [
      embed({
        color: active ? COLORS.info : COLORS.grey,
        title: `👥 Tarea #${task.id} — quién hizo y quién no`,
        url: task.tweetUrl,
        description: [
          `**${summary.completed.length}** ${summary.completed.length === 1 ? 'completó' : 'completaron'} · **${summary.pending.length}** en revisión · **${summary.partial.length}** ${summary.partial.length === 1 ? 'incompleta' : 'incompletas'}${
            summary.expectedCount !== null ? ` · **${summary.missing.length}** sin participar` : ''
          }`,
          expectedNote(task, summary),
          active ? `Termina ${discordTs(task.endsAt, 'R')}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        fields: summaryFields(summary),
      }),
    ],
    components: [],
  });
}

function reportMessage(task, summary, settings, { guildId } = {}) {
  const perAction = task.actions
    .map((a) => {
      const pa = summary.perAction[a];
      return `${ACTION_INFO[a].emoji} ${ACTION_INFO[a].label}: **${pa.verified}**${pa.pending ? ` (+${pa.pending} en revisión)` : ''}`;
    })
    .join('\n');
  const stats = [`Participación: **${summary.completionRate}%**`, perAction];
  if (summary.avgQuality !== null) stats.push(`Calidad media de comentarios: **${summary.avgQuality}/100**`);
  const fields = [field('📈 Estadísticas', stats.join('\n')), ...summaryFields(summary)];
  const flags = task.flags || [];
  if (flags.length || task.report?.revoked) {
    const lines = flags.map((f) => `• ${f.message}`);
    if (task.report?.revoked) lines.push(`• ${task.report.revoked} comentario(s) se borraron después de verificarse y se anularon.`);
    fields.push(field('⚠️ Alertas antifraude', lines.join('\n')));
  }

  const payload = {
    embeds: [
      embed({
        color: COLORS.gold,
        title: `📊 Resultado final — Tarea #${task.id}`,
        url: task.tweetUrl,
        description: [
          `**${summary.completed.length}** ${summary.completed.length === 1 ? 'miembro completó' : 'miembros completaron'} la tarea${summary.expectedCount !== null ? ` de **${summary.expectedCount}** ${summary.expectedCount === 1 ? 'esperado' : 'esperados'}` : ''}.`,
          expectedNote(task, summary),
        ]
          .filter(Boolean)
          .join('\n'),
        fields,
        footer: { text: 'Informe generado automáticamente al terminar la tarea' },
        timestamp: new Date().toISOString(),
      }),
    ],
    components: [],
    allowedMentions: { parse: [], users: [], roles: [] },
  };
  const url = messageUrl(guildId || task.guildId, task.channelId, task.messageId);
  if (url) payload.components.push(row(button({ label: 'Ir a la tarea', emoji: '↩️', url })));

  if (settings.report.mentionMissing) {
    const targets = [...summary.missing, ...summary.partial].slice(0, 100);
    if (targets.length) {
      payload.content = truncate(`❌ **No completaron la tarea #${task.id}:** ${targets.map((u) => `<@${u.id}>`).join(' ')}`, 2000);
      payload.allowedMentions = { parse: [], roles: [], users: targets.map((u) => u.id) };
    }
  }
  return payload;
}

// ─── Recordatorios ──────────────────────────────────────────────
/** Divide las menciones en mensajes de ≤2000 caracteres y ≤100 menciones cada uno. */
function reminderMessages(task, users, { guildId } = {}) {
  const url = messageUrl(guildId || task.guildId, task.channelId, task.messageId);
  const header = `⏰ **Recordatorio:** la tarea **#${task.id}** termina ${discordTs(task.endsAt, 'R')}. Aún os falta completarla:`;
  const chunks = [];
  let current = [];
  let len = header.length;
  for (const u of users) {
    const m = `<@${u.id}>`;
    if (current.length >= 90 || len + m.length + 1 > 1900) {
      chunks.push(current);
      current = [];
      len = header.length;
    }
    current.push(u.id);
    len += m.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks.slice(0, 5).map((ids, i) => ({
    content: `${i === 0 ? header : '⏰ …'} ${ids.map((id) => `<@${id}>`).join(' ')}`,
    components: i === 0 && url ? [row(button({ label: 'Ir a la tarea', emoji: '🚀', url }))] : [],
    allowedMentions: { parse: [], roles: [], users: ids },
  }));
}

function reminderDM(task, guildName) {
  const url = messageUrl(task.guildId, task.channelId, task.messageId);
  return {
    embeds: [
      embed({
        color: COLORS.warn,
        title: `⏰ Te falta completar la tarea #${task.id}`,
        description: `En **${escapeMd(guildName || 'tu servidor')}** hay una tarea de engagement que termina ${discordTs(task.endsAt, 'R')}.\n${actionsLine(task.actions)}`,
        url: task.tweetUrl,
      }),
    ],
    components: url ? [row(button({ label: 'Ir a la tarea', emoji: '🚀', url }))] : [],
  };
}

// ─── Revisión por el staff ──────────────────────────────────────
function reviewMessage(task, sub, user, imageUrl, { decided = null } = {}) {
  const info = ACTION_INFO[sub.action];
  const e = embed({
    color: decided ? (decided.approve ? COLORS.ok : COLORS.error) : COLORS.warn,
    title: decided ? `${decided.approve ? '✅ Aprobado' : '❌ Rechazado'} · ${info.emoji} ${info.label}` : `🕵️ Revisión pendiente · ${info.emoji} ${info.label}`,
    description: [
      `**Miembro:** <@${sub.userId}>${user?.xHandle ? ` · [@${user.xHandle}](${profileUrl(user.xHandle)})` : ''}`,
      `**Tarea:** [#${task.id}](${task.tweetUrl})`,
      `**Tipo de prueba:** ${sub.method === 'screenshot' ? 'captura de pantalla' : 'declaración (sin captura)'}`,
      decided ? `**Revisado por:** ${decided.by}${decided.reason ? `\n**Motivo:** ${escapeMd(decided.reason)}` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    image: imageUrl ? { url: imageUrl } : undefined,
    footer: { text: `Envío ${sub.id}` },
    timestamp: new Date(sub.updatedAt || Date.now()).toISOString(),
  });
  return {
    embeds: [e],
    components: decided
      ? []
      : [
          row(
            button({ id: `eng:rev:ok:${sub.id}`, label: 'Aprobar', style: 'success', emoji: '✅' }),
            button({ id: `eng:rev:no:${sub.id}`, label: 'Rechazar', style: 'danger', emoji: '✖️' }),
          ),
        ],
    allowedMentions: { parse: [], users: [], roles: [] },
  };
}

function reviewResultDM(task, sub, approve, reason) {
  const info = ACTION_INFO[sub.action];
  return {
    embeds: [
      embed({
        color: approve ? COLORS.ok : COLORS.error,
        title: approve ? `✅ Tu ${info.label.toLowerCase()} fue aprobado` : `❌ Tu ${info.label.toLowerCase()} fue rechazado`,
        description: `Tarea [#${task.id}](${task.tweetUrl}).${!approve && reason ? `\n**Motivo:** ${escapeMd(reason)}` : ''}`,
      }),
    ],
  };
}

// ─── Vinculación de cuenta ──────────────────────────────────────
function linkStartMessage({ handle, code, tweetIntent, expiresAt, allowUnverified }) {
  const components = [
    row(
      button({ id: 'eng:link:bio', label: 'Verificar biografía', style: 'primary', emoji: '🔎' }),
      button({ id: 'eng:link:tweet', label: 'Verificar con post', emoji: '🐦' }),
      allowUnverified ? button({ id: 'eng:link:skip', label: 'Vincular sin verificar', emoji: '⏭️' }) : null,
    ),
    row(
      button({ label: 'Editar mi perfil de X', emoji: '✏️', url: 'https://x.com/settings/profile' }),
      button({ label: 'Publicar el código', emoji: '📝', url: tweetIntent }),
    ),
  ];
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.x,
        title: '🔗 Vincula tu cuenta de X',
        description: [
          `Vas a vincular **[@${handle}](${profileUrl(handle)})**. Demuestra que es tuya con una de estas opciones:`,
          '',
          '**Opción A · Biografía (recomendada)**',
          `1. Copia este código: \`${code}\``,
          '2. Pégalo en la **biografía** de tu perfil de X y guarda.',
          '3. Pulsa **🔎 Verificar biografía**. Después ya puedes quitarlo.',
          '',
          '**Opción B · Post**',
          '1. Pulsa **📝 Publicar el código** (se abre X con el texto listo) y publícalo.',
          '2. Copia el enlace del post y pulsa **🐦 Verificar con post**.',
        ].join('\n'),
        fields: [field('Código', `\`${code}\``, true), field('Caduca', discordTs(expiresAt, 'R'), true)],
        footer: { text: 'Sólo se hace una vez · funciona en todos los servidores del bot' },
      }),
    ],
    components,
  });
}

function linkedMessage(link) {
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.ok,
        title: '✅ Cuenta de X vinculada',
        description: `Tu Discord ahora está vinculado a **[@${link.handle}](${profileUrl(link.handle)})**${link.verified ? ' (verificada)' : ' (sin verificar)'}.\nYa puedes participar en las tareas: pulsa **✅ Ya lo hice** en cualquier tarea activa.${
          link.protected ? '\n\n⚠️ Tu cuenta es **privada**: el bot no podrá ver tus comentarios. Hazla pública para que se verifiquen.' : ''
        }`,
        thumbnail: link.xAvatar ? { url: link.xAvatar } : undefined,
      }),
    ],
    components: [],
  });
}

function needLinkMessage(unverified = false) {
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.warn,
        title: unverified ? '🔒 Verifica tu cuenta de X' : '🔗 Primero vincula tu cuenta de X',
        description: unverified
          ? 'Tu cuenta está vinculada pero sin verificar. Pulsa el botón para verificarla (tarda 1 minuto).'
          : 'Para comprobar tus interacciones necesito saber cuál es tu cuenta de X. Sólo se hace una vez.',
      }),
    ],
    components: [row(button({ id: 'eng:link:start', label: unverified ? 'Verificar mi cuenta' : 'Vincular mi cuenta', style: 'primary', emoji: '🔗' }))],
  });
}

// ─── Modales ────────────────────────────────────────────────────
function textInput({ id, label, description, placeholder, required = true, style = 1, min, max = 300, value }) {
  const input = { type: 4, custom_id: id, style, required, max_length: max };
  if (placeholder) input.placeholder = truncate(placeholder, 100);
  if (min) input.min_length = min;
  if (value) input.value = value;
  const labelComp = { type: 18, label: truncate(label, 45), component: input };
  if (description) labelComp.description = truncate(description, 100);
  return labelComp;
}

function verifyModal(task, needed) {
  const components = [];
  if (needed.includes('reply')) {
    components.push(
      textInput({
        id: 'reply',
        label: 'Enlace de tu comentario',
        description: 'En X abre tu respuesta › Compartir › Copiar enlace',
        placeholder: 'https://x.com/tuusuario/status/123…',
      }),
    );
  }
  if (needed.includes('quote')) {
    components.push(
      textInput({
        id: 'quote',
        label: 'Enlace de tu cita',
        description: 'El enlace de tu post citando la publicación',
        placeholder: 'https://x.com/tuusuario/status/123…',
      }),
    );
  }
  return { custom_id: `eng:m:verify:${task.id}`, title: truncate(`Verificar tarea #${task.id}`, 45), components };
}

function linkStartModal() {
  return {
    custom_id: 'eng:m:linkstart',
    title: 'Vincular cuenta de X',
    components: [textInput({ id: 'handle', label: 'Tu usuario de X', placeholder: '@tuusuario', max: 40, description: 'El @ de tu perfil de X' })],
  };
}

function linkTweetModal() {
  return {
    custom_id: 'eng:m:linktweet',
    title: 'Verificar con un post',
    components: [textInput({ id: 'url', label: 'Enlace del post con el código', placeholder: 'https://x.com/tuusuario/status/123…' })],
  };
}

function rejectModal(subId) {
  return {
    custom_id: `eng:m:reject:${subId}`,
    title: 'Rechazar envío',
    components: [textInput({ id: 'reason', label: 'Motivo (lo verá el miembro)', required: false, style: 2, max: 300, placeholder: 'La captura no muestra el like…' })],
  };
}

// ─── Perfil, ranking y listas ───────────────────────────────────
function profileMessage({ user, member, link, rank }) {
  const lvl = trustLevel(member?.trust);
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.info,
        author: { name: user.displayName || user.username, icon_url: user.avatar || undefined },
        title: '📇 Perfil de engagement',
        thumbnail: link?.xAvatar ? { url: link.xAvatar } : undefined,
        fields: [
          field(
            'Cuenta de X',
            link ? `[@${link.handle}](${profileUrl(link.handle)}) ${link.verified ? '✅ verificada' : '⚠️ sin verificar'}` : 'No vinculada · usa `/vincular`',
          ),
          field('🏆 Puntos', `**${fmtNum(member?.points || 0)}**${rank ? ` · puesto #${rank}` : ''}`, true),
          field(`${lvl.emoji} Confianza`, `**${member?.trust ?? 50}/100** · ${lvl.label}`, true),
          field('🔥 Racha', `**${member?.streak || 0}** (mejor: ${member?.bestStreak || 0})`, true),
          field('✅ Completadas', fmtNum(member?.completed || 0), true),
          field('❌ No completadas', fmtNum(member?.missed || 0), true),
          field('🚫 Rechazos', fmtNum(member?.rejected || 0), true),
        ],
        footer: member?.blacklisted ? { text: '⛔ Bloqueado para participar en tareas' } : undefined,
      }),
    ],
    components: [],
  });
}

function leaderboardMessage(rows, { title, guildName }) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map(
    (r, i) =>
      `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${fmtNum(r.points)} pts** · ✅ ${fmtNum(r.completed || 0)}${r.streak ? ` · 🔥 ${r.streak}` : ''}${r.x_handle ? ` · @${escapeMd(r.x_handle)}` : ''}`,
  );
  return {
    embeds: [
      embed({
        color: COLORS.gold,
        title: `🏆 ${title}`,
        description: lines.length ? lines.join('\n') : 'Todavía no hay puntos en este periodo. ¡Participa en las tareas para aparecer aquí!',
        footer: guildName ? { text: guildName } : undefined,
      }),
    ],
    components: [],
    allowedMentions: { parse: [], users: [], roles: [] },
  };
}

function taskListMessage(tasks, { guildId, completedBy = new Map() } = {}) {
  if (!tasks.length) return infoMessage('No hay tareas activas ahora mismo. ¡Vuelve más tarde!', { title: '📭 Sin tareas activas' });
  const lines = tasks.slice(0, 15).map((t) => {
    const url = messageUrl(guildId || t.guildId, t.channelId, t.messageId);
    const who = t.tweet?.author?.handle ? `@${escapeMd(t.tweet.author.handle)}` : 'post';
    const done = completedBy.get(t.id);
    return `${done ? '✅' : '▫️'} **[#${t.id}](${url || t.tweetUrl})** · ${who} · ${t.actions.map((a) => ACTION_INFO[a].emoji).join('')} · termina ${discordTs(t.endsAt, 'R')}`;
  });
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.info,
        title: `📋 Tareas activas (${tasks.length})`,
        description: lines.join('\n') + (tasks.length > 15 ? `\n… y ${tasks.length - 15} más` : ''),
        footer: { text: '✅ = ya la completaste' },
      }),
    ],
    components: [],
  });
}

function configMessage(s, { dashboardUrl } = {}) {
  const ch = (id) => (id ? `<#${id}>` : '*sin configurar*');
  const role = (id) => (id ? `<@&${id}>` : '*ninguno*');
  const v = s.verification;
  const proof = { declared: 'Declaración (confianza)', screenshot: 'Captura obligatoria', review: 'Revisión del staff' }[v.proofMode];
  const components = dashboardUrl ? [row(button({ label: 'Abrir panel web', emoji: '🖥️', url: dashboardUrl }))] : [];
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.info,
        title: '⚙️ Configuración del servidor',
        fields: [
          field('Canales', `Tareas: ${ch(s.tasksChannelId)}\nRegistro/revisión: ${ch(s.logChannelId)}\nInformes: ${s.report.channelId ? ch(s.report.channelId) : 'el mismo de la tarea'}`, true),
          field('Roles', `Participantes: ${role(s.participantRoleId)}\nStaff: ${role(s.staffRoleId)}\nMencionar: ${role(s.pingRoleId)}`, true),
          field(
            'Verificación',
            `Like/Repost: **${proof}**\nRepost en perfil: ${v.repostTimelineCheck ? 'sí' : 'no'}\nCalidad mínima comentarios: **${v.minReplyQuality}/100**\nAntiplagio: ${v.antiDuplicate ? 'sí' : 'no'} · Recomprobar al cerrar: ${v.recheckOnClose ? 'sí' : 'no'}\nVinculación verificada: ${v.requireVerifiedLink ? 'obligatoria' : 'opcional'}`,
          ),
          field('Puntos', `❤️ ${s.points.like} · 🔁 ${s.points.repost} · 💬 ${s.points.reply} · 🗨️ ${s.points.quote} · bonus ${s.points.bonus}`, true),
          field('Por defecto', `${actionsLine(s.defaultActions)}\nDuración: ${formatDuration(s.defaultDurationMinutes)}`, true),
          field('Recordatorios', s.reminders.enabled ? `${s.reminders.minutesBefore} min antes · ${{ channel: 'en el canal', dm: 'por MD', both: 'canal + MD' }[s.reminders.mode]}` : 'desactivados', true),
        ],
        footer: { text: 'Todo esto también se puede cambiar desde el panel web' },
      }),
    ],
    components,
  });
}

function helpMessage({ staff, dashboardUrl }) {
  const member = [
    '`/vincular usuario` — vincula tu cuenta de X (una sola vez)',
    '`/tareas` — tareas activas y cuáles te faltan',
    '`/verificar tarea` — verifica una tarea (igual que el botón ✅)',
    '`/prueba tarea accion imagen` — sube una captura como prueba',
    '`/perfil [miembro]` — puntos, racha y confianza',
    '`/ranking [periodo]` — clasificación del servidor',
    '`/desvincular` — quita tu cuenta de X',
  ];
  const staffCmds = [
    '`/tarea crear enlace …` — publica una tarea nueva',
    '`/tarea estado|cerrar|cancelar|recordar|extender` — gestiona tareas',
    '`/miembro puntos|bloquear|desbloquear|vincular|desvincular`',
    '`/config ver|canal|logs|rol-participantes|…` — ajustes',
    '`/panel` — enlace al panel web',
  ];
  const fields = [field('👤 Para todos', member.join('\n'))];
  if (staff) fields.push(field('🛡️ Staff', staffCmds.join('\n')));
  fields.push(
    field(
      '¿Cómo se verifica sin la API de X?',
      '💬 **Comentarios y citas:** se leen de X y se comprueba autor, destino, calidad y copias.\n🔁 **Reposts:** se buscan en tu perfil público.\n❤️ **Likes:** X los hizo privados, así que se usan declaración, captura o revisión (según el servidor) y se contrastan con el contador público del post.',
    ),
  );
  return ephemeral({
    embeds: [embed({ color: COLORS.info, title: '📖 Ayuda del bot de engagement', fields })],
    components: dashboardUrl && staff ? [row(button({ label: 'Panel web', emoji: '🖥️', url: dashboardUrl }))] : [],
  });
}

function tweetPreviewFields(tweet) {
  const m = tweet.metrics || {};
  return `❤️ ${fmtCompact(m.likes)} · 🔁 ${fmtCompact(m.reposts)} · 💬 ${fmtCompact(m.replies)}`;
}

module.exports = {
  EPHEMERAL,
  COLORS,
  STATUS_ICON,
  METHOD_LABEL,
  field,
  embed,
  row,
  button,
  mentionList,
  messageUrl,
  ephemeral,
  errorMessage,
  successMessage,
  infoMessage,
  taskMessage,
  progressMessage,
  statusMessage,
  reportMessage,
  reminderMessages,
  reminderDM,
  reviewMessage,
  reviewResultDM,
  linkStartMessage,
  linkedMessage,
  needLinkMessage,
  verifyModal,
  linkStartModal,
  linkTweetModal,
  rejectModal,
  profileMessage,
  leaderboardMessage,
  taskListMessage,
  configMessage,
  helpMessage,
  tweetPreviewFields,
  actionsLine,
  taskPoints,
};
