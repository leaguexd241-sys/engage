'use strict';

const { stripAccents, words, countEmojis, stripLeadingMentions, URL_RE } = require('../util/text');

/** Frases completas que se consideran comentarios genéricos (normalizadas, sin acentos). */
const GENERIC_PHRASES = new Set(
  [
    'buen post', 'buena publicacion', 'buen tweet', 'excelente', 'excelente post', 'genial', 'increible', 'top', 'brutal',
    'que bueno', 'que buena', 'me gusta', 'me encanta', 'de acuerdo', 'totalmente de acuerdo', 'asi es', 'exacto',
    'wow', 'guau', 'vamos', 'vamo', 'dale', 'fuego', 'like', 'hecho', 'listo', 'ok', 'si', 'gracias', 'hola', 'buenas',
    'buenos dias', 'jaja', 'jajaja', 'jajajaja', 'xd', 'eso', 'great', 'nice', 'cool', 'amazing', 'awesome', 'gm', 'gn',
    'lfg', 'wagmi', 'based', 'facts', 'this', 'same', 'yes', 'true', 'love it', 'lets go', 'congrats', 'felicidades',
    'bullish', 'moon', 'to the moon', 'done', 'first', 'nice post', 'great post', 'good', 'good post', 'so good',
    'lo mejor', 'crack', 'idolo', 'grande', 'epico', 'sii', 'siii', 'yes sir', 'real', 'fr', 'w', 'huge', 'insane',
  ].map((s) => s.trim()),
);

/** Palabras "de relleno": un comentario compuesto sólo de estas se considera genérico. */
const FILLER = new Set(
  (
    'nice great cool good amazing awesome post tweet bro sis gm gn lfg wow yes love it this so very much buen bueno buena ' +
    'publicacion excelente genial top brutal que me gusta encanta muy super wagmi based facts lets let go vamos dale fuego ' +
    'hecho listo ok si jaja jajaja jajajaja xd gracias hola true same congrats felicidades bullish moon the to done first ' +
    'increible epico crack grande sir real fr w huge insane lo mejor asi es exacto de acuerdo totalmente guau wen wena'
  ).split(/\s+/),
);

const STOPWORDS = new Set(
  (
    'a al algo algunos ante antes aqui asi aun como con contra cual cuando de del desde donde dos el ella ellas ellos en ' +
    'entre era eres es esa ese eso esta este esto estos fue ha han hasta hay la las le les lo los mas me mi mis muy nada ' +
    'ni no nos nosotros o os otra otro para pero poco por porque que quien se sea ser si sin sobre son su sus tambien ' +
    'te tiene todo todos tu tus un una uno unos ya yo the and for are but not you all any can her was one our out day ' +
    'get has him his how man new now old see two way who boy did its let put say she too use with have this that from ' +
    'they will would there their what about which when make like time just know take into year your good some could them ' +
    'than then look only come over think also back after work first well even want because these give most'
  ).split(/\s+/),
);

const SPAM_RE =
  /(follow ?back|sigueme|seguime|dm me|mandame dm|check (my|out my) (bio|profile)|mira mi perfil|gana dinero|earn \$|airdrop|giveaway|promo ?code|link in (my )?bio|t\.me\/|whatsapp|onlyfans|free crypto|send me)/i;

const LENGTH_POINTS = [0, 6, 12, 20, 26, 31, 35, 38, 40, 42, 43, 44, 44, 45, 45];

function stem(w) {
  return w.length > 5 ? w.slice(0, 5) : w;
}

function contentWords(text) {
  return words(stripAccents(String(text || '').toLowerCase())).filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function grade(score) {
  if (score >= 75) return { key: 'excelente', label: 'Excelente' };
  if (score >= 50) return { key: 'bueno', label: 'Bueno' };
  if (score >= 30) return { key: 'aceptable', label: 'Aceptable' };
  if (score >= 15) return { key: 'bajo', label: 'Bajo' };
  return { key: 'spam', label: 'Spam / vacío' };
}

/**
 * Analiza la calidad de un comentario.
 * Combina longitud, variedad, relación con el post original, estructura y señales de spam.
 * @returns {{score:number, grade:{key:string,label:string}, notes:string[], stats:object}}
 */
function analyzeReply(text, { tweetText = '' } = {}) {
  const clean = stripLeadingMentions(String(text || '')).trim();
  const noUrls = clean.replace(URL_RE, ' ');
  const ws = words(noUrls);
  const lower = ws.map((w) => stripAccents(w.toLowerCase()));
  const nWords = ws.length;
  const unique = new Set(lower).size;
  const emojis = countEmojis(clean);
  const notes = [];
  let score = 0;

  if (nWords === 0) {
    const onlyEmoji = emojis > 0;
    notes.push(onlyEmoji ? 'Sólo contiene emojis' : 'El comentario no tiene texto');
    const s = onlyEmoji ? 3 : 0;
    return { score: s, grade: grade(s), notes, stats: { words: 0, unique: 0, emojis, relevance: 0 } };
  }

  // 1) Longitud (0-45)
  score += nWords >= LENGTH_POINTS.length ? 45 : LENGTH_POINTS[nWords];

  // 2) Variedad de palabras (0-15)
  const uniqueRatio = unique / nWords;
  score += Math.round(uniqueRatio * (nWords >= 3 ? 15 : 8));

  // 3) Relación con el post (0-20)
  let overlap = 0;
  const tweetWords = new Set(contentWords(tweetText).map(stem));
  if (tweetWords.size > 0) {
    const replyStems = new Set(contentWords(noUrls).map(stem));
    for (const w of replyStems) if (tweetWords.has(w)) overlap += 1;
    score += overlap >= 3 ? 20 : overlap === 2 ? 16 : overlap === 1 ? 10 : 0;
    if (overlap > 0) notes.push(`Relacionado con el post (${overlap} ${overlap === 1 ? 'tema' : 'temas'} en común)`);
  } else {
    score += 8;
  }

  // 4) Estructura (0-10)
  const letters = noUrls.replace(/[^\p{L}]/gu, '');
  const upperRatio = letters ? letters.replace(/[^\p{Lu}]/gu, '').length / letters.length : 0;
  if (/[.!?¡¿,;:]/.test(clean) || nWords >= 6) score += 5;
  if (nWords >= 2 && upperRatio < 0.8) score += 5;

  // 5) Uso equilibrado de emojis (0-10)
  if (emojis === 0) score += 6;
  else if (emojis <= 3 && emojis / (nWords + emojis) <= 0.3) score += 10;
  else notes.push('Demasiados emojis');

  // Penalizaciones
  const normalized = lower.join(' ');
  const generic = GENERIC_PHRASES.has(normalized) || (nWords <= 6 && lower.every((w) => FILLER.has(w)));
  if (generic) {
    score -= 35;
    notes.push('Comentario genérico (no aporta nada)');
  }
  if (/(.)\1{4,}/u.test(clean.replace(/\s/g, ''))) {
    score -= 10;
    notes.push('Caracteres repetidos');
  }
  const counts = new Map();
  for (const w of lower) counts.set(w, (counts.get(w) || 0) + 1);
  if (nWords >= 3 && Math.max(...counts.values()) >= 3 && uniqueRatio < 0.5) {
    score -= 10;
    notes.push('Palabras repetidas');
  }
  if (nWords >= 3 && letters.length >= 8 && upperRatio > 0.8) {
    score -= 8;
    notes.push('Todo en mayúsculas');
  }
  if (SPAM_RE.test(stripAccents(clean))) {
    score = Math.min(score, 45) - 30;
    notes.push('Posible spam o autopromoción');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (!generic && nWords < 3) notes.push('Muy corto');
  return {
    score,
    grade: grade(score),
    notes,
    stats: { words: nWords, unique, emojis, relevance: overlap },
  };
}

module.exports = { analyzeReply, grade, contentWords };
