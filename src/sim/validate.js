'use strict';

/**
 * Valida un mensaje con los mismos límites que la API de Discord.
 * Si algo aquí falla, Discord también rechazaría el mensaje.
 */
class PayloadError extends Error {
  constructor(message) {
    super(`Mensaje inválido para Discord: ${message}`);
    this.name = 'PayloadError';
  }
}

const len = (s) => (s === undefined || s === null ? 0 : String(s).length);

function validateEmbed(e, i) {
  const where = `embed ${i + 1}`;
  if (len(e.title) > 256) throw new PayloadError(`${where}: título > 256`);
  if (len(e.description) > 4096) throw new PayloadError(`${where}: descripción > 4096`);
  if (e.fields && e.fields.length > 25) throw new PayloadError(`${where}: más de 25 campos`);
  if (len(e.footer?.text) > 2048) throw new PayloadError(`${where}: pie > 2048`);
  if (len(e.author?.name) > 256) throw new PayloadError(`${where}: autor > 256`);
  if (e.color !== undefined && (!Number.isInteger(e.color) || e.color < 0 || e.color > 0xffffff)) throw new PayloadError(`${where}: color no válido`);
  if (e.url && !/^https?:\/\//.test(e.url)) throw new PayloadError(`${where}: url no válida`);
  for (const k of ['image', 'thumbnail']) {
    if (e[k] && !/^(https?:|attachment:)/.test(e[k].url || '')) throw new PayloadError(`${where}: ${k}.url no válida`);
  }
  let total = len(e.title) + len(e.description) + len(e.footer?.text) + len(e.author?.name);
  for (const [j, f] of (e.fields || []).entries()) {
    if (!len(f.name) || len(f.name) > 256) throw new PayloadError(`${where}, campo ${j + 1}: nombre vacío o > 256`);
    if (!len(f.value) || len(f.value) > 1024) throw new PayloadError(`${where}, campo ${j + 1} (“${f.name}”): valor vacío o > 1024`);
    total += len(f.name) + len(f.value);
  }
  if (e.timestamp && Number.isNaN(Date.parse(e.timestamp))) throw new PayloadError(`${where}: timestamp no válido`);
  return total;
}

function validateComponents(rows) {
  if (!Array.isArray(rows)) throw new PayloadError('components debe ser una lista');
  if (rows.length > 5) throw new PayloadError('más de 5 filas de componentes');
  const ids = new Set();
  for (const [r, row] of rows.entries()) {
    if (row.type !== 1) throw new PayloadError(`fila ${r + 1}: tipo no válido`);
    if (!row.components?.length || row.components.length > 5) throw new PayloadError(`fila ${r + 1}: debe tener 1-5 botones`);
    for (const b of row.components) {
      if (b.type !== 2) throw new PayloadError(`fila ${r + 1}: sólo se admiten botones`);
      if (!b.label && !b.emoji) throw new PayloadError(`fila ${r + 1}: botón sin texto ni emoji`);
      if (len(b.label) > 80) throw new PayloadError(`fila ${r + 1}: etiqueta > 80`);
      if (b.style === 5) {
        if (!b.url || !/^(https?|discord):\/\//.test(b.url)) throw new PayloadError(`fila ${r + 1}: botón de enlace sin url válida`);
        if (len(b.url) > 512) throw new PayloadError(`fila ${r + 1}: url del botón > 512`);
        if (b.custom_id) throw new PayloadError(`fila ${r + 1}: un botón de enlace no puede tener custom_id`);
      } else {
        if (!b.custom_id || len(b.custom_id) > 100) throw new PayloadError(`fila ${r + 1}: botón sin custom_id válido`);
        if (ids.has(b.custom_id)) throw new PayloadError(`custom_id repetido: ${b.custom_id}`);
        ids.add(b.custom_id);
        if (![1, 2, 3, 4].includes(b.style)) throw new PayloadError(`fila ${r + 1}: estilo de botón no válido`);
      }
    }
  }
}

function validateMessage(p, { edit = false } = {}) {
  if (!p || typeof p !== 'object') throw new PayloadError('mensaje vacío');
  if (len(p.content) > 2000) throw new PayloadError('contenido > 2000 caracteres');
  const embeds = p.embeds || [];
  if (embeds.length > 10) throw new PayloadError('más de 10 embeds');
  let total = 0;
  embeds.forEach((e, i) => {
    total += validateEmbed(e, i);
  });
  if (total > 6000) throw new PayloadError(`los embeds suman ${total} caracteres (máximo 6000)`);
  if (p.components) validateComponents(p.components);
  if (!edit && !len(p.content) && !embeds.length && !(p.components || []).length) throw new PayloadError('el mensaje no tiene contenido');
  const am = p.allowedMentions;
  if (am?.users && am.users.length > 100) throw new PayloadError('allowedMentions.users admite como máximo 100 usuarios');
  if (am?.roles && am.roles.length > 100) throw new PayloadError('allowedMentions.roles admite como máximo 100 roles');
  return true;
}

module.exports = { validateMessage, PayloadError };
