// svg-sprite.mjs
// Turns standalone SVG files into <symbol> elements of a single inline
// sprite, referenced with <svg><use href="#id"/></svg>.
//
// - Symbol ids are a short hash of the icon path: stable across runs,
//   valid as HTML ids, and never clashing between icons.
// - Ids inside an icon (gradients, clip paths, masks) are prefixed with the
//   symbol id, since every symbol shares the same document.
// - Icons carrying <style> or <script> cannot be inlined safely (their rules
//   would apply to the whole page): canInline() reports them so the caller
//   can keep an isolated <img> for them.

import { createHash } from 'node:crypto';

const ROOT_RE = /<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i;
const ID_RE = /\bid\s*=\s*["']([^"']+)["']/g;

/** Stable symbol id for an icon path (e.g. "fr/boards/D.svg"). */
export const symbolIdOf = (path) =>
  'i' + createHash('sha1').update(path).digest('hex').slice(0, 10);

/** False when the icon must not share the page document. */
export const canInline = (source) => !/<(style|script)\b/i.test(source);

/** Inner markup of the root <svg> element, ids prefixed with `prefix`. */
function innerMarkup(source, prefix) {
  const body = (source.match(ROOT_RE) || [, ''])[1];
  const ids = [...body.matchAll(ID_RE)].map((m) => m[1]);
  return ids.reduce((result, id) => result
    .replace(new RegExp(`\\bid\\s*=\\s*(["'])${escapeRe(id)}\\1`, 'g'), `id="${prefix}-${id}"`)
    .replaceAll(`url(#${id})`, `url(#${prefix}-${id})`)
    .replace(new RegExp(`(href\\s*=\\s*["'])#${escapeRe(id)}(["'])`, 'g'), `$1#${prefix}-${id}$2`), body);
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One <symbol> element.
 * @param {string} id        symbol id (see symbolIdOf)
 * @param {string} source    full SVG file content
 * @param {string|null} viewBox  "x y w h", or null when the icon has none
 */
export function toSymbol(id, source, viewBox) {
  const vb = viewBox ? ` viewBox="${viewBox}"` : '';
  return `<symbol id="${id}"${vb}>${innerMarkup(source, id)}</symbol>`;
}

/**
 * The sprite element holding all symbols. It is hidden by size rather than
 * display:none, because gradients inside a display:none SVG do not render.
 */
export function renderSprite(symbols) {
  if (symbols.length === 0) return '';
  return '<svg xmlns="http://www.w3.org/2000/svg" class="sprite" aria-hidden="true" focusable="false">\n'
    + symbols.join('\n')
    + '\n</svg>';
}
