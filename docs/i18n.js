'use strict';
/* Languages: all official EU languages. The phone's language is the default; Settings can change it.
   Dictionaries live in i18n/<code>.js: en.js holds the keys and English, pl.js Polish, the others are
   arrays in the same order as the English keys. */

const LANGS = [['bg', 'Български'], ['cs', 'Čeština'], ['da', 'Dansk'], ['de', 'Deutsch'], ['el', 'Ελληνικά'], ['en', 'English'],
  ['es', 'Español'], ['et', 'Eesti'], ['fi', 'Suomi'], ['fr', 'Français'], ['ga', 'Gaeilge'], ['hr', 'Hrvatski'], ['hu', 'Magyar'],
  ['it', 'Italiano'], ['lt', 'Lietuvių'], ['lv', 'Latviešu'], ['mt', 'Malti'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['pt', 'Português'],
  ['ro', 'Română'], ['sk', 'Slovenčina'], ['sl', 'Slovenščina'], ['sv', 'Svenska']];
const I18N = {};

function pickLang() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('ek.lang')); } catch {}
  if (saved && LANGS.some(l => l[0] === saved)) return saved;
  for (const tag of navigator.languages || [navigator.language || 'en']) {
    const code = String(tag).toLowerCase().split(/[-_]/)[0];
    if (LANGS.some(l => l[0] === code)) return code;
  }
  return 'en';
}
const LANG = pickLang();
document.documentElement.lang = LANG;
// Load English (keys + fallback) and the chosen language before the app scripts run.
document.write('<script src="i18n/en.js"></script>' + (LANG !== 'en' ? `<script src="i18n/${LANG}.js"></script>` : ''));

let DICT = null;
function dict() {
  if (DICT) return DICT;
  const en = I18N.en || {}, d = I18N[LANG];
  if (Array.isArray(d)) { DICT = {}; Object.keys(en).forEach((k, i) => { if (d[i] != null && d[i] !== '') DICT[k] = d[i]; }); }
  else DICT = d || {};
  return DICT;
}
// t('key', {name: 'Ania'}) -> text in the current language with {name} filled in.
function t(k, v) {
  let s = dict()[k] ?? I18N.en?.[k] ?? k;
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] ?? ''));
  return s;
}
const NUM = new Intl.NumberFormat(LANG, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const INT = new Intl.NumberFormat(LANG, { maximumFractionDigits: 0 });
const fmt1 = x => NUM.format(x);
const fmt0 = x => INT.format(Math.round(x));
// Static text in index.html: data-i (text), data-i-ph (placeholder), data-i-aria (aria-label), data-i-html (with markup).
function applyI18n(root = document) {
  root.querySelectorAll('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
  root.querySelectorAll('[data-i-html]').forEach(el => { el.innerHTML = t(el.dataset.iHtml); });
  root.querySelectorAll('[data-i-ph]').forEach(el => { el.placeholder = t(el.dataset.iPh); });
  root.querySelectorAll('[data-i-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.iAria)); });
  document.title = t('app.title');
}
function langSelect(sel) {
  sel.innerHTML = LANGS.map(([c, n]) => `<option value="${c}"${c === LANG ? ' selected' : ''}>${n}</option>`).join('');
  sel.onchange = () => { try { localStorage.setItem('ek.lang', JSON.stringify(sel.value)); } catch {} location.reload(); };
}
