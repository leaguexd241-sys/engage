'use strict';

const MIN_DURATION = 5; // minutos
const MAX_DURATION = 60 * 24 * 30; // 30 días

/**
 * Convierte "90", "45m", "2h", "1h30m", "1d", "1d 6h" a minutos.
 * Devuelve null si el formato no es válido.
 */
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? Math.round(input) : null;
  const s = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  // Las alternativas más largas van primero para que "horas" no se quede en "h".
  const re = /(\d+(?:[.,]\d+)?)(minutos|minuto|mins|min|m|horas|hora|hrs|hr|h|días|dias|día|dia|d)/g;
  let total = 0;
  let consumed = 0;
  let match;
  while ((match = re.exec(s)) !== null) {
    const value = Number(match[1].replace(',', '.'));
    const unit = match[2][0];
    total += unit === 'd' ? value * 1440 : unit === 'h' ? value * 60 : value;
    consumed += match[0].length;
  }
  if (consumed !== s.length || total <= 0) return null;
  return Math.round(total);
}

function clampDuration(min) {
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(min)));
}

function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const parts = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (mm || parts.length === 0) parts.push(`${mm} min`);
  return parts.join(' ');
}

/** Marca de tiempo nativa de Discord (se muestra en la zona horaria de cada usuario). */
function discordTs(ms, style = 'f') {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

module.exports = { parseDuration, clampDuration, formatDuration, discordTs, sleep, MIN_DURATION, MAX_DURATION };
