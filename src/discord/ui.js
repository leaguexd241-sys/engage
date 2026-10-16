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
  auto: 'verified on X',
  timeline: 'found on your profile',
  declared: 'declared',
  screenshot: 'screenshot provided',
  manual: 'marked by staff',
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
    const suffix = rest > 1 ? ` … and ${rest} more` : '';
    if (len + s.length + 2 + suffix.length > max) {
      parts.push(`… and ${rest} more`);
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

function errorMessage(text, { title = 'Could not complete the action' } = {}) {
  return ephemeral({ embeds: [embed({ color: COLORS.error, title: `❌ ${title}`, description: text })], components: [] });
}

function successMessage(text, { title = 'Done' } = {}) {
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
  const statusText = active ? 'Active' : task.status === 'closed' ? 'Finished' : 'Cancelled';
  const color = active ? colorInt(settings?.embedColor) : task.status === 'closed' ? COLORS.grey : COLORS.error;

  const base = view.expectedCount ?? null;
  const progress =
    base !== null && base > 0
      ? `${progressBar(view.completed / base)}  **${view.completed}/${base}** completed (${pct(view.completed, base)}%)`
      : `**${view.completed}** completed · **${view.participants}** participating`;

  const steps = ['**1.** Use the buttons to complete each action on X.', '**2.** Come back and press **✅ I did it**.'];
  if (task.actions.includes('reply') || task.actions.includes('quote')) {
    steps.push(`**3.** Paste the link to your ${task.actions.includes('reply') ? 'reply' : 'quote'} when prompted by the bot.`);
  }

  let description = quoteBlock(t.text || '(post without text)', 700);
  if (t.media?.length > 1) description += `\n*+${t.media.length - 1} more file(s) in the post*`;
  if (task.note) description += `\n\n📝 **Staff note:** ${escapeMd(truncate(task.note, 500))}`;

  const fields = [];
  if (active) fields.push(field('🎯 What to do', steps.join('\n')));
  fields.push(
    field(active ? '⏰ Ends' : '⏰ Ended', `${discordTs(active ? task.endsAt : task.closedAt || task.endsAt, 'R')}\n${discordTs(active ? task.endsAt : task.closedAt || task.endsAt, 'f')}`, true),
    field('🏆 Reward', `**${pts.total} pts**${pts.bonus ? `\n(${pts.base} + ${pts.bonus} bonus)` : ''}`, true),
    field('📊 Progress', progress),
  );

  const image = t.media?.find((m) => m.url)?.url;
  const e = embed({
    color,
    author: author.handle
      ? { name: `${author.name || author.handle} (@${author.handle})`, url: profileUrl(author.handle), icon_url: author.avatar || undefined }
      : undefined,
    title: `${active ? '🚀' : task.status === 'closed' ? '🏁' : '⛔'} Task #${task.id} · ${actionsLine(task.actions)}`,
    url: task.tweetUrl,
    description,
    fields,
    image: image ? { url: image } : undefined,
    footer: { text: `${statusText} · ID ${task.id} · Verification without the X API` },
    timestamp: new Date(task.createdAt).toISOString(),
  });

  const components = [];
  if (active) {
    const links = task.actions.map((a) => {
      if (a === 'like') return button({ label: 'Like', emoji: '❤️', url: intents.like(task.tweetId) });
      if (a === 'repost') return button({ label: 'Repost', emoji: '🔁', url: intents.repost(task.tweetId) });
      if (a === 'reply') return button({ label: 'Reply', emoji: '💬', url: intents.reply(task.tweetId) });
      return button({ label: 'Quote', emoji: '🗨️', url: intents.quote(task.tweetId, author.handle) });
    });
    links.push(button({ label: 'Open post', emoji: '🔗', url: task.tweetUrl }));
    components.push(row(...links));
    components.push(
      row(
        button({ id: `eng:verify:${task.id}`, label: 'I did it', style: 'success', emoji: '✅' }),
        button({ id: `eng:progress:${task.id}`, label: 'My progress', emoji: '📋' }),
        button({ id: `eng:status:${task.id}`, label: 'Participation', emoji: '👥' }),
      ),
    );
  } else {
    components.push(
      row(
        button({ id: `eng:status:${task.id}`, label: task.status === 'closed' ? 'View results' : 'View participation', emoji: '📊' }),
        button({ label: 'Open post', emoji: '🔗', url: task.tweetUrl }),
      ),
    );
  }

  // Al editar no se toca el texto (así la mención del primer envío se conserva).
  const content = active && task.pingRoleId && !task.messageId ? `<@&${task.pingRoleId}> New engagement task! 🚀` : undefined;
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
    else if (item.status === 'verified') detail = `Done (${METHOD_LABEL[item.sub?.method] || 'verified'})${item.sub?.quality != null ? ` · quality ${item.sub.quality}/100` : ''}`;
    else if (item.status === 'pending') detail = 'Awaiting staff review';
    else if (item.status === 'awaiting') detail = `Screenshot required: \`/proof task:${task.id} action:${item.action}\``;
    else if (item.status === 'rejected' || item.status === 'revoked') detail = item.sub?.reason || 'Rejected';
    else detail = 'Pending';
    return `${STATUS_ICON[status] || '⬜'} **${info.emoji} ${info.label}** — ${detail}`;
  });

  const anyRejected = (results || []).some((r) => r.state === 'rejected' || r.state === 'error' || r.state === 'missing');
  let color = COLORS.info;
  let title = `📋 Your progress on task #${task.id}`;
  if (completedNow) {
    color = COLORS.ok;
    title = '🎉 Task completed!';
  } else if (progress.complete) {
    color = COLORS.ok;
    title = `✅ Task #${task.id} completed`;
  } else if (anyRejected) {
    color = COLORS.error;
    title = `⚠️ Task #${task.id}: some actions are missing`;
  } else if (progress.state === 'pending') {
    color = COLORS.warn;
    title = `🕓 Task #${task.id}: awaiting review`;
  }

  const fields = [field('Progress', `${progressBar(progress.done / (progress.total || 1), 10)}  **${progress.done}/${progress.total}**`, true)];
  if (pointsEarned !== null) fields.push(field('Points for this task', `**${fmtNum(pointsEarned)}**`, true));

  const components = [];
  const open = task.status === 'active' && task.endsAt > Date.now();
  if (open && !progress.complete && progress.state !== 'pending') {
    components.push(row(button({ id: `eng:verify:${task.id}`, label: anyRejected ? 'Retry' : 'I did it', style: 'success', emoji: '✅' })));
  }
  return ephemeral({
    embeds: [
      embed({
        color,
        title,
        url: task.tweetUrl,
        description: lines.join('\n'),
        fields,
        footer: open && !progress.complete ? { text: 'If something failed, correct it on X and press ✅ again' } : undefined,
      }),
    ],
    components,
  });
}

// ─── Quién hizo y quién no ──────────────────────────────────────
function summaryFields(summary) {
  const fmtPartial = (u) => `<@${u.id}> (${u.done}/${u.total})`;
  const fields = [field(`✅ Completed (${summary.completed.length})`, mentionList(summary.completed))];
  if (summary.pending.length) fields.push(field(`🕓 Awaiting review (${summary.pending.length})`, mentionList(summary.pending)));
  if (summary.partial.length) fields.push(field(`⚠️ Incomplete (${summary.partial.length})`, mentionList(summary.partial, 1000, fmtPartial)));
  if (summary.expectedCount !== null) fields.push(field(`❌ Did not participate (${summary.missing.length})`, mentionList(summary.missing)));
  return fields;
}

function expectedNote(task, summary) {
  if (summary.expectedSource === 'role') return `Expected participants: role <@&${task.roleId}> (${fmtNum(summary.expectedCount)} members).`;
  if (summary.expectedSource === 'linked') return `Compared with the ${fmtNum(summary.expectedCount)} members with a linked X account.`;
  return '';
}

function statusMessage(task, summary) {
  const active = task.status === 'active';
  return ephemeral({
    embeds: [
      embed({
        color: active ? COLORS.info : COLORS.grey,
        title: `👥 Task #${task.id} — participation status`,
        url: task.tweetUrl,
        description: [
          `**${summary.completed.length}** completed · **${summary.pending.length}** awaiting review · **${summary.partial.length}** incomplete${
            summary.expectedCount !== null ? ` · **${summary.missing.length}** did not participate` : ''
          }`,
          expectedNote(task, summary),
          active ? `Ends ${discordTs(task.endsAt, 'R')}.` : '',
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
      return `${ACTION_INFO[a].emoji} ${ACTION_INFO[a].label}: **${pa.verified}**${pa.pending ? ` (+${pa.pending} awaiting review)` : ''}`;
    })
    .join('\n');
  const stats = [`Participation: **${summary.completionRate}%**`, perAction];
  if (summary.avgQuality !== null) stats.push(`Average reply quality: **${summary.avgQuality}/100**`);
  const fields = [field('📈 Statistics', stats.join('\n')), ...summaryFields(summary)];
  const flags = task.flags || [];
  if (flags.length || task.report?.revoked) {
    const lines = flags.map((f) => `• ${f.message}`);
    if (task.report?.revoked) lines.push(`• ${task.report.revoked} reply/replies were deleted after verification and revoked.`);
    fields.push(field('⚠️ Integrity alerts', lines.join('\n')));
  }

  const payload = {
    embeds: [
      embed({
        color: COLORS.gold,
        title: `📊 Final report — Task #${task.id}`,
        url: task.tweetUrl,
        description: [
          `**${summary.completed.length}** ${summary.completed.length === 1 ? 'member completed' : 'members completed'} the task${summary.expectedCount !== null ? ` out of **${summary.expectedCount}** ${summary.expectedCount === 1 ? 'expected' : 'expected'}` : ''}.`,
          expectedNote(task, summary),
        ]
          .filter(Boolean)
          .join('\n'),
        fields,
        footer: { text: 'Report generated automatically when the task ended' },
        timestamp: new Date().toISOString(),
      }),
    ],
    components: [],
    allowedMentions: { parse: [], users: [], roles: [] },
  };
  const url = messageUrl(guildId || task.guildId, task.channelId, task.messageId);
  if (url) payload.components.push(row(button({ label: 'Go to task', emoji: '↩️', url })));

  if (settings.report.mentionMissing) {
    const targets = [...summary.missing, ...summary.partial].slice(0, 100);
    if (targets.length) {
      payload.content = truncate(`❌ **Did not complete task #${task.id}:** ${targets.map((u) => `<@${u.id}>`).join(' ')}`, 2000);
      payload.allowedMentions = { parse: [], roles: [], users: targets.map((u) => u.id) };
    }
  }
  return payload;
}

// ─── Recordatorios ──────────────────────────────────────────────
/** Divide las menciones en mensajes de ≤2000 caracteres y ≤100 menciones cada uno. */
function reminderMessages(task, users, { guildId } = {}) {
  const url = messageUrl(guildId || task.guildId, task.channelId, task.messageId);
  const header = `⏰ **Reminder:** the task **#${task.id}** ends ${discordTs(task.endsAt, 'R')}. Please complete the remaining actions:`;
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
    components: i === 0 && url ? [row(button({ label: 'Go to task', emoji: '🚀', url }))] : [],
    allowedMentions: { parse: [], roles: [], users: ids },
  }));
}

function reminderDM(task, guildName) {
  const url = messageUrl(task.guildId, task.channelId, task.messageId);
  return {
    embeds: [
      embed({
        color: COLORS.warn,
        title: `⏰ Please complete task #${task.id}`,
        description: `In **${escapeMd(guildName || 'your server')}** an engagement task ends ${discordTs(task.endsAt, 'R')}.\n${actionsLine(task.actions)}`,
        url: task.tweetUrl,
      }),
    ],
    components: url ? [row(button({ label: 'Go to task', emoji: '🚀', url }))] : [],
  };
}

// ─── Revisión por el staff ──────────────────────────────────────
function reviewMessage(task, sub, user, imageUrl, { decided = null } = {}) {
  const info = ACTION_INFO[sub.action];
  const e = embed({
    color: decided ? (decided.approve ? COLORS.ok : COLORS.error) : COLORS.warn,
    title: decided ? `${decided.approve ? '✅ Approved' : '❌ Rejected'} · ${info.emoji} ${info.label}` : `🕵️ Pending review · ${info.emoji} ${info.label}`,
    description: [
      `**Member:** <@${sub.userId}>${user?.xHandle ? ` · [@${user.xHandle}](${profileUrl(user.xHandle)})` : ''}`,
      `**Task:** [#${task.id}](${task.tweetUrl})`,
      `**Evidence type:** ${sub.method === 'auto' ? 'Post verified on X · quality review' : sub.method === 'screenshot' ? 'screenshot' : 'declaration (no screenshot)'}`,
      sub.method === 'auto' ? `**Quality estimate:** ${sub.quality}/100\n${quoteBlock(sub.evidenceText, 700)}\n[View evidence on X](${sub.evidenceUrl})` : '',
      decided ? `**Reviewed by:** ${decided.by}${decided.reason ? `\n**Reason:** ${escapeMd(decided.reason)}` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    image: imageUrl ? { url: imageUrl } : undefined,
    footer: { text: `Submission ${sub.id}` },
    timestamp: new Date(sub.updatedAt || Date.now()).toISOString(),
  });
  return {
    embeds: [e],
    components: decided
      ? []
      : [
          row(
            button({ id: `eng:rev:ok:${sub.id}`, label: 'Approve', style: 'success', emoji: '✅' }),
            button({ id: `eng:rev:no:${sub.id}`, label: 'Reject', style: 'danger', emoji: '✖️' }),
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
        title: approve ? `✅ Your ${info.label.toLowerCase()} was approved` : `❌ Your ${info.label.toLowerCase()} was rejected`,
        description: `Task [#${task.id}](${task.tweetUrl}).${!approve && reason ? `\n**Reason:** ${escapeMd(reason)}` : ''}`,
      }),
    ],
  };
}

// ─── Vinculación de cuenta ──────────────────────────────────────
function linkStartMessage({ handle, code, tweetIntent, expiresAt, allowUnverified }) {
  const components = [
    row(
      button({ id: 'eng:link:bio', label: 'Verify bio', style: 'primary', emoji: '🔎' }),
      button({ id: 'eng:link:tweet', label: 'Verify with post', emoji: '🐦' }),
      allowUnverified ? button({ id: 'eng:link:skip', label: 'Link without verification', emoji: '⏭️' }) : null,
    ),
    row(
      button({ label: 'Edit my X profile', emoji: '✏️', url: 'https://x.com/settings/profile' }),
      button({ label: 'Post the code', emoji: '📝', url: tweetIntent }),
    ),
  ];
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.x,
        title: '🔗 Link your X account',
        description: [
          `You are linking **[@${handle}](${profileUrl(handle)})**. Prove you own it using either option:`,
          '',
          '**Option A · Bio (recommended)**',
          `1. Copy this code: \`${code}\``,
          '2. Paste it into your X profile **bio** and save.',
          '3. Press **🔎 Verify bio**. You can then remove the code.',
          '',
          '**Option B · Post**',
          '1. Press **📝 Post the code** and publish the prefilled post on X.',
          '2. Copy the post link and press **🐦 Verify with post**.',
        ].join('\n'),
        fields: [field('Code', `\`${code}\``, true), field('Expires', discordTs(expiresAt, 'R'), true)],
        footer: { text: 'One-time setup · works across all servers using this bot' },
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
        title: '✅ X account linked',
        description: `Your Discord account is now linked to **[@${link.handle}](${profileUrl(link.handle)})**${link.verified ? ' (verified)' : ' (unverified)'}.\nYou can now participate: press **✅ I did it** on any active task.${
          link.protected ? '\n\n⚠️ Your account is **private**. Make it public so the bot can verify your replies.' : ''
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
        title: unverified ? '🔒 Verify your X account' : '🔗 Link your X account first',
        description: unverified
          ? 'Your account is linked but unverified. Press the button to verify it (about 1 minute).'
          : 'Link your X account so the bot can verify your interactions. You only need to do this once.',
      }),
    ],
    components: [row(button({ id: 'eng:link:start', label: unverified ? 'Verify my account' : 'Link my account', style: 'primary', emoji: '🔗' }))],
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
        label: 'Your reply link',
        description: 'On X, open your reply › Share › Copy link',
        placeholder: 'https://x.com/tuusuario/status/123…',
      }),
    );
  }
  if (needed.includes('quote')) {
    components.push(
      textInput({
        id: 'quote',
        label: 'Your quote link',
        description: 'The link to your quote of the original post',
        placeholder: 'https://x.com/tuusuario/status/123…',
      }),
    );
  }
  return { custom_id: `eng:m:verify:${task.id}`, title: truncate(`Verify task #${task.id}`, 45), components };
}

function linkStartModal() {
  return {
    custom_id: 'eng:m:linkstart',
    title: 'Link X account',
    components: [textInput({ id: 'handle', label: 'Your X username', placeholder: '@tuusuario', max: 40, description: 'Your X profile handle' })],
  };
}

function linkTweetModal() {
  return {
    custom_id: 'eng:m:linktweet',
    title: 'Verify with a post',
    components: [textInput({ id: 'url', label: 'Link to the post containing your code', placeholder: 'https://x.com/tuusuario/status/123…' })],
  };
}

function rejectModal(subId) {
  return {
    custom_id: `eng:m:reject:${subId}`,
    title: 'Reject submission',
    components: [textInput({ id: 'reason', label: 'Reason (visible to the member)', required: false, style: 2, max: 300, placeholder: 'The screenshot does not show a like…' })],
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
        title: '📇 Engagement profile',
        thumbnail: link?.xAvatar ? { url: link.xAvatar } : undefined,
        fields: [
          field(
            'X account',
            link ? `[@${link.handle}](${profileUrl(link.handle)}) ${link.verified ? '✅ verified' : '⚠️ unverified'}` : 'Not linked · use `/link`',
          ),
          field('🏆 Points', `**${fmtNum(member?.points || 0)}**${rank ? ` · rank #${rank}` : ''}`, true),
          field(`${lvl.emoji} Trust`, `**${member?.trust ?? 50}/100** · ${lvl.label}`, true),
          field('🔥 Streak', `**${member?.streak || 0}** (best: ${member?.bestStreak || 0})`, true),
          field('✅ Completed', fmtNum(member?.completed || 0), true),
          field('❌ Incomplete', fmtNum(member?.missed || 0), true),
          field('🚫 Rejections', fmtNum(member?.rejected || 0), true),
        ],
        footer: member?.blacklisted ? { text: '⛔ Blocked from participating in tasks' } : undefined,
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
        description: lines.length ? lines.join('\n') : 'No points in this period yet. Participate in tasks to appear here!',
        footer: guildName ? { text: guildName } : undefined,
      }),
    ],
    components: [],
    allowedMentions: { parse: [], users: [], roles: [] },
  };
}

function taskListMessage(tasks, { guildId, completedBy = new Map() } = {}) {
  if (!tasks.length) return infoMessage('No active tasks right now. Check back later!', { title: '📭 No active tasks' });
  const lines = tasks.slice(0, 15).map((t) => {
    const url = messageUrl(guildId || t.guildId, t.channelId, t.messageId);
    const who = t.tweet?.author?.handle ? `@${escapeMd(t.tweet.author.handle)}` : 'post';
    const done = completedBy.get(t.id);
    return `${done ? '✅' : '▫️'} **[#${t.id}](${url || t.tweetUrl})** · ${who} · ${t.actions.map((a) => ACTION_INFO[a].emoji).join('')} · ends ${discordTs(t.endsAt, 'R')}`;
  });
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.info,
        title: `📋 Active tasks (${tasks.length})`,
        description: lines.join('\n') + (tasks.length > 15 ? `\n… and ${tasks.length - 15} more` : ''),
        footer: { text: '✅ = already completed' },
      }),
    ],
    components: [],
  });
}

function configMessage(s) {
  const ch = (id) => (id ? `<#${id}>` : '*not configured*');
  const role = (id) => (id ? `<@&${id}>` : '*none*');
  const v = s.verification;
  const proof = { declared: 'Declaration (trust)', screenshot: 'Screenshot required', review: 'Staff review' }[v.proofMode];
  const components = [];
  return ephemeral({
    embeds: [
      embed({
        color: COLORS.info,
        title: '⚙️ Server settings',
        fields: [
          field('Channels', `Tasks: ${ch(s.tasksChannelId)}\nLog/review: ${ch(s.logChannelId)}\nReports: ${s.report.channelId ? ch(s.report.channelId) : 'task channel'}`, true),
          field('Roles', `Participants: ${role(s.participantRoleId)}\nStaff: ${role(s.staffRoleId)}\nMention: ${role(s.pingRoleId)}`, true),
          field(
            'Verification',
            `Like/Repost: **${proof}**\nCheck public reposts: ${v.repostTimelineCheck ? 'yes' : 'no'}\nQuality review threshold: **${v.minReplyQuality}/100**\nCheck duplicates: ${v.antiDuplicate ? 'yes' : 'no'} · Recheck on close: ${v.recheckOnClose ? 'yes' : 'no'}\nVerified link: ${v.requireVerifiedLink ? 'required' : 'optional'}`,
          ),
          field('Points', `❤️ ${s.points.like} · 🔁 ${s.points.repost} · 💬 ${s.points.reply} · 🗨️ ${s.points.quote} · bonus ${s.points.bonus}`, true),
          field('Defaults', `${actionsLine(s.defaultActions)}\nDuration: ${formatDuration(s.defaultDurationMinutes)}`, true),
          field('Reminders', s.reminders.enabled ? `${s.reminders.minutesBefore} min before · ${{ channel: 'channel', dm: 'DM', both: 'channel + DM' }[s.reminders.mode]}` : 'disabled', true),
        ],
        footer: { text: 'Use /config to update these settings. Use /points to set rewards for future posts.' },
      }),
    ],
    components,
  });
}

function helpMessage({ staff }) {
  const member = [
    '`/link user` — link your X account (one-time setup)',
    '`/tasks` — active tasks and your remaining tasks',
    '`/verify task` — verify a task (same as the ✅ button)',
    '`/proof task action image` — upload a screenshot as evidence',
    '`/profile [member]` — points, streak and trust',
    '`/ranking [period]` — server leaderboard',
    '`/unlink` — unlink your X account',
  ];
  const staffCmds = [
    '`/task create url …` — publish a new task',
    '`/task status|close|cancel|remind|extend` — manage tasks',
    '`/member points|block|unblock|link|unlink`',
    '`/config view|channel|logs|participant-role|…` — settings',
    '`/points like:2 reply:5 bonus:3` — default rewards for future posts (administrators)',
    '`/task create url:… reply-points:10 bonus-points:5` — custom rewards for one post',
  ];
  const fields = [field('👤 Everyone', member.join('\n'))];
  if (staff) fields.push(field('🛡️ Staff', staffCmds.join('\n')));
  fields.push(
    field(
      'How does verification work without the X API?',
      '💬 **Replies and quotes:** checked on X for author, target and duplicate text. Low quality estimates go to staff review.\n🔁 **Reposts:** checked on your public profile.\n❤️ **Likes:** verified by declaration, screenshot or staff review, depending on server settings. Public counters provide a general audit.',
    ),
  );
  return ephemeral({
    embeds: [embed({ color: COLORS.info, title: '📖 Engagement bot help', fields })],
    components: [],
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
