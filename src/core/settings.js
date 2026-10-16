'use strict';

const { isSnowflake } = require('../util/ids');
const { clampDuration } = require('../util/time');

const ACTIONS = ['like', 'repost', 'reply', 'quote'];

const ACTION_INFO = {
  like: { label: 'Like', emoji: '❤️', verb: 'dar like' },
  repost: { label: 'Repost', emoji: '🔁', verb: 'repostear' },
  reply: { label: 'Comentario', emoji: '💬', verb: 'comentar' },
  quote: { label: 'Cita', emoji: '🗨️', verb: 'citar' },
};

const PROOF_MODES = ['declared', 'screenshot', 'review'];
const REMINDER_MODES = ['channel', 'dm', 'both'];

const DEFAULT_SETTINGS = Object.freeze({
  tasksChannelId: null,
  logChannelId: null,
  participantRoleId: null,
  staffRoleId: null,
  pingRoleId: null,
  defaultActions: ['like', 'repost', 'reply'],
  defaultDurationMinutes: 60,
  points: { like: 1, repost: 2, reply: 3, quote: 3, bonus: 2 },
  verification: {
    requireLink: true,
    requireVerifiedLink: true,
    proofMode: 'declared',
    autoApproveTrust: 85,
    repostTimelineCheck: true,
    minReplyQuality: 35,
    allowThreadReplies: false,
    antiDuplicate: true,
    duplicateThreshold: 0.8,
    recheckOnClose: true,
    maxAttempts: 5,
  },
  reminders: { enabled: true, minutesBefore: 15, mode: 'channel' },
  report: { enabled: true, mentionMissing: false, channelId: null },
  publicStatus: true,
  embedColor: '#1D9BF0',
});

function clone(o) {
  return structuredClone(o);
}

const idOrNull = (v) => (v === null || v === '' || v === undefined ? null : isSnowflake(String(v)) || /^sim-/.test(String(v)) ? String(v) : undefined);
const intIn = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const numIn = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
};
const boolOf = (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);

/**
 * Aplica sobre `base` los cambios de `patch` validando cada campo.
 * Los campos inválidos se ignoran y se devuelven en `errors`.
 */
function applySettingsPatch(base, patch) {
  const out = clone(base);
  const errors = [];
  if (!patch || typeof patch !== 'object') return { settings: out, errors };

  const setId = (key, value) => {
    const v = idOrNull(value);
    if (v === undefined) errors.push(`${key}: ID no válido`);
    else out[key] = v;
  };

  for (const key of ['tasksChannelId', 'logChannelId', 'participantRoleId', 'staffRoleId', 'pingRoleId']) {
    if (key in patch) setId(key, patch[key]);
  }

  if ('defaultActions' in patch) {
    const list = Array.isArray(patch.defaultActions) ? [...new Set(patch.defaultActions.filter((a) => ACTIONS.includes(a)))] : [];
    if (list.length === 0) errors.push('defaultActions: elige al menos una acción');
    else out.defaultActions = ACTIONS.filter((a) => list.includes(a));
  }

  if ('defaultDurationMinutes' in patch) {
    const n = Number(patch.defaultDurationMinutes);
    if (!Number.isFinite(n) || n <= 0) errors.push('defaultDurationMinutes: número no válido');
    else out.defaultDurationMinutes = clampDuration(n);
  }

  if (patch.points && typeof patch.points === 'object') {
    for (const k of [...ACTIONS, 'bonus']) {
      if (k in patch.points) {
        const v = intIn(patch.points[k], 0, 1000);
        if (v === undefined) errors.push(`points.${k}: número no válido`);
        else out.points[k] = v;
      }
    }
  }

  const v = patch.verification;
  if (v && typeof v === 'object') {
    for (const k of ['requireLink', 'requireVerifiedLink', 'repostTimelineCheck', 'allowThreadReplies', 'antiDuplicate', 'recheckOnClose']) {
      if (k in v) {
        const b = boolOf(v[k]);
        if (b === undefined) errors.push(`verification.${k}: debe ser verdadero/falso`);
        else out.verification[k] = b;
      }
    }
    if ('proofMode' in v) {
      if (PROOF_MODES.includes(v.proofMode)) out.verification.proofMode = v.proofMode;
      else errors.push('verification.proofMode: modo no válido');
    }
    const ranges = { autoApproveTrust: [0, 101], minReplyQuality: [0, 100], maxAttempts: [1, 20] };
    for (const [k, [min, max]] of Object.entries(ranges)) {
      if (k in v) {
        const n = intIn(v[k], min, max);
        if (n === undefined) errors.push(`verification.${k}: número no válido`);
        else out.verification[k] = n;
      }
    }
    if ('duplicateThreshold' in v) {
      const n = numIn(v.duplicateThreshold, 0.5, 1);
      if (n === undefined) errors.push('verification.duplicateThreshold: número no válido');
      else out.verification.duplicateThreshold = n;
    }
  }

  const r = patch.reminders;
  if (r && typeof r === 'object') {
    if ('enabled' in r) {
      const b = boolOf(r.enabled);
      if (b === undefined) errors.push('reminders.enabled: debe ser verdadero/falso');
      else out.reminders.enabled = b;
    }
    if ('minutesBefore' in r) {
      const n = intIn(r.minutesBefore, 1, 1440);
      if (n === undefined) errors.push('reminders.minutesBefore: número no válido');
      else out.reminders.minutesBefore = n;
    }
    if ('mode' in r) {
      if (REMINDER_MODES.includes(r.mode)) out.reminders.mode = r.mode;
      else errors.push('reminders.mode: modo no válido');
    }
  }

  const rep = patch.report;
  if (rep && typeof rep === 'object') {
    for (const k of ['enabled', 'mentionMissing']) {
      if (k in rep) {
        const b = boolOf(rep[k]);
        if (b === undefined) errors.push(`report.${k}: debe ser verdadero/falso`);
        else out.report[k] = b;
      }
    }
    if ('channelId' in rep) {
      const id = idOrNull(rep.channelId);
      if (id === undefined) errors.push('report.channelId: ID no válido');
      else out.report.channelId = id;
    }
  }

  if ('publicStatus' in patch) {
    const b = boolOf(patch.publicStatus);
    if (b === undefined) errors.push('publicStatus: debe ser verdadero/falso');
    else out.publicStatus = b;
  }

  if ('embedColor' in patch) {
    if (/^#[0-9a-f]{6}$/i.test(String(patch.embedColor))) out.embedColor = String(patch.embedColor).toUpperCase();
    else errors.push('embedColor: usa formato #RRGGBB');
  }

  return { settings: out, errors };
}

/** Mezcla lo guardado con los valores por defecto (por si se añaden opciones nuevas). */
function withDefaults(stored) {
  const { settings } = applySettingsPatch(clone(DEFAULT_SETTINGS), stored || {});
  return settings;
}

function colorInt(hex) {
  return Number.parseInt(String(hex || '#1D9BF0').replace('#', ''), 16) || 0x1d9bf0;
}

module.exports = {
  ACTIONS,
  ACTION_INFO,
  PROOF_MODES,
  REMINDER_MODES,
  DEFAULT_SETTINGS,
  applySettingsPatch,
  withDefaults,
  colorInt,
};
