'use strict';

const { normalizeForCompare } = require('../util/text');

function trigrams(s) {
  const padded = `  ${s} `;
  const set = new Set();
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
  return set;
}

/** Similitud 0..1 entre dos textos (Jaccard de trigramas sobre texto normalizado). */
function similarity(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Busca si `text` es una copia de alguno de los candidatos.
 * Los textos muy cortos no cuentan como copia (coincidencias casuales): de eso se encarga el filtro de calidad.
 * @param {{text:string}[]} candidates
 */
function findDuplicate(text, candidates, threshold = 0.8) {
  const norm = normalizeForCompare(text);
  if (norm.length < 20) return null;
  let best = null;
  for (const c of candidates) {
    if (!c?.text) continue;
    const s = similarity(text, c.text);
    if (s >= threshold && (!best || s > best.similarity)) best = { ...c, similarity: Math.round(s * 100) / 100 };
  }
  return best;
}

module.exports = { similarity, findDuplicate };
