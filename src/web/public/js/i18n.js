import phrases from './translations.js';

const languages = new Set(['es', 'en']);
let language = 'es';
try {
  const saved = localStorage.getItem('engage-language');
  if (languages.has(saved)) language = saved;
} catch { /* Storage can be unavailable in private browsing. */ }
document.documentElement.lang = language;

export const getLanguage = () => language;
export const getLocale = () => language === 'en' ? 'en-US' : 'es-ES';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dictionaries = {};
for (const lang of languages) {
  const entries = phrases.map(([es, en]) => lang === 'en' ? [es, en] : [en, es]).filter(([a, b]) => a && a !== b);
  const map = new Map(entries);
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  dictionaries[lang] = {
    map,
    re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${keys.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'gu'),
  };
}

/** Translate UI copy only. Never use this on IDs, URLs, inputs or user content. */
export function t(value, lang = language) {
  const text = String(value ?? '');
  const dictionary = dictionaries[lang] || dictionaries.es;
  return dictionary.map.get(text) ?? text.replace(dictionary.re, (match) => dictionary.map.get(match));
}

const originals = new WeakMap();
const attributeOriginals = new WeakMap();
const ATTRS = ['title', 'aria-label', 'placeholder'];
const EXCLUDED = 'script,style,textarea,code,[data-i18n-ignore],.dc-msg,.dc-embed,.dc-components,.tweet-text,.tweet-head strong,.task-card .text,.who strong,.guild-btn .name,.guild-icon,.mention,.feed-item .txt,.log-box';
const ATTRIBUTE_EXCLUDED = EXCLUDED.replace('textarea,', '');

function textNode(node) {
  if (!node.parentElement || node.parentElement.closest(EXCLUDED) || !node.data.trim()) return;
  const option = node.parentElement.closest('option');
  if (option && /^\d{5,25}$/.test(option.value)) return;
  let saved = originals.get(node);
  if (!saved || saved.result !== node.data) saved = { source: node.data, result: node.data };
  const result = t(saved.source);
  if (node.data !== result) node.data = result;
  saved.result = result;
  originals.set(node, saved);
}

function attributes(element) {
  if (element.closest(ATTRIBUTE_EXCLUDED)) return;
  let saved = attributeOriginals.get(element);
  if (!saved) { saved = {}; attributeOriginals.set(element, saved); }
  for (const name of ATTRS) {
    const current = element.getAttribute(name);
    if (current === null) continue;
    if (!saved[name] || saved[name].result !== current) saved[name] = { source: current, result: current };
    const result = t(saved[name].source);
    if (current !== result) element.setAttribute(name, result);
    saved[name].result = result;
  }
}

export function localize(root = document.body) {
  if (!root?.isConnected) return;
  if (root.nodeType === Node.TEXT_NODE) { textNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  attributes(root);
  if (root.closest(EXCLUDED)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === Node.TEXT_NODE) textNode(walker.currentNode);
    else attributes(walker.currentNode);
  }
}

export function languageSelect() {
  return `<select class="input language-select" data-language aria-label="Language / Idioma"><option value="es" ${language === 'es' ? 'selected' : ''}>Español</option><option value="en" ${language === 'en' ? 'selected' : ''}>English</option></select>`;
}

export function setLanguage(next) {
  if (!languages.has(next)) return;
  language = next;
  document.documentElement.lang = next;
  try { localStorage.setItem('engage-language', next); } catch { /* optional */ }
  document.querySelectorAll('[data-language]').forEach((el) => { el.value = next; });
  localize();
  window.dispatchEvent(new CustomEvent('engage:language', { detail: next }));
}

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-language]')) setLanguage(event.target.value);
});

// WeakMaps do not retain removed pages. Observe only changed subtrees; there is
// no polling, network translation or HTML rewriting, so forms keep their values.
const observer = new MutationObserver((records) => {
  const roots = new Set();
  for (const record of records) {
    if (record.type === 'childList') for (const node of record.addedNodes) roots.add(node);
    else roots.add(record.target);
  }
  for (const root of roots) localize(root);
});
observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
localize();
window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS }); localize(); }
});
