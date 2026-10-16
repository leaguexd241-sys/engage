'use strict';

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const EMOJI_PART_RE = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const MENTION_RE = /(^|[^\w])@\w{1,15}/g;
const WORD_RE = /[\p{L}\p{N}]+/gu;

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Texto normalizado para comparar similitud (sin enlaces, menciones, emojis ni signos). */
function normalizeForCompare(s) {
  return stripAccents(String(s || '').toLowerCase())
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, ' ')
    .replace(EMOJI_PART_RE, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(s) {
  return String(s || '').match(WORD_RE) || [];
}

function countEmojis(s) {
  return (String(s || '').match(EMOJI_RE) || []).length;
}

/** Quita las menciones iniciales que X añade automáticamente en las respuestas. */
function stripLeadingMentions(s) {
  return String(s || '').replace(/^(\s*@\w{1,15})+\s*/, '');
}

/**
 * Recorta a `max` unidades UTF-16 (como cuenta Discord los límites), sin partir emojis.
 */
function truncate(s, max) {
  const str = String(s ?? '');
  if (max <= 0) return '';
  if (str.length <= max) return str;
  let out = '';
  for (const ch of str) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out.trimEnd() + '…';
}

/** Escapa markdown de Discord y neutraliza @everyone/@here. */
function escapeMd(s) {
  return String(s ?? '')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<([@#][!&]?\d+|a?:\w+:\d+|t:\d+(?::\w)?)>/g, '<\u200b$1>')
    .replace(/([\\*_~`|>[\]()#-])/g, '\\$1');
}

/** Cita un bloque de texto para un embed de Discord (con escape). */
function quoteBlock(s, max = 600) {
  const text = truncate(String(s || '').trim(), max);
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => '> ' + escapeMd(line))
    .join('\n');
}

function progressBar(ratio, width = 12) {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(r * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

const nf = new Intl.NumberFormat('es-ES');
const nfCompact = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });

function fmtNum(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return nf.format(Number(n));
}

function fmtCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return nfCompact.format(Number(n));
}

function plural(n, singular, pluralForm) {
  return `${fmtNum(n)} ${n === 1 ? singular : pluralForm || singular + 's'}`;
}

function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

module.exports = {
  stripAccents,
  normalizeForCompare,
  words,
  countEmojis,
  stripLeadingMentions,
  truncate,
  escapeMd,
  quoteBlock,
  progressBar,
  fmtNum,
  fmtCompact,
  plural,
  pct,
  EMOJI_RE,
  URL_RE,
};
