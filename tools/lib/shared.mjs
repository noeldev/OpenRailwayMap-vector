// shared.mjs
// Project-root resolution and SVG helpers shared by all tools.
// Every tool imports PROJECT_ROOT / DEFAULT_* from here, so the defaults
// are always correct regardless of the current working directory.

import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { readdir, access } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to tools/. */
export const TOOLS_DIR = dirname(__dirname);

/** Absolute path to the project root (parent of tools/). */
export const PROJECT_ROOT = dirname(TOOLS_DIR);

/** Default SVG directory: <project>/symbols/fr */
export const DEFAULT_SVG_ROOT = join(PROJECT_ROOT, 'symbols', 'fr');

/** Default YAML file: <project>/features/signals_railway_signals.yaml */
export const DEFAULT_YAML_FILE = join(PROJECT_ROOT, 'features', 'signals_railway_signals.yaml');

/**
 * Minimum safe viewBox dimension (smallest of width/height), shared by:
 *   - audit-svg.mjs, as the default --min size-warning threshold;
 *   - svg-tidy.mjs, as the cutoff below which the 2.5-unit design-grid
 *     coordinate snap is skipped entirely, since on a small viewBox that
 *     step is large enough relative to the icon to visibly distort it.
 * Below this size an icon is already flagged by the audit for manual
 * review, so the tidy pass leaves its coordinates exactly as drawn.
 */
export const DEFAULT_MIN_VIEWBOX_DIM = 100;

/** Convert a filesystem path to forward-slash form for display. */
export const toPosix = (p) => p.split(sep).join('/');

/** Display a path relative to the project root, or absolute if outside. */
export const relToProject = (p) => {
  const rel = relative(PROJECT_ROOT, p);
  return rel && !rel.startsWith('..') ? toPosix(rel) : p;
};

/** Non-throwing existence check. */
export async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Recursively yield absolute file paths under `dir`.
 * Options:
 *   ext       - only yield files ending with this extension (lowercase, e.g. '.svg')
 *   skipDirs  - directory names to skip (e.g. ['_backup'])
 * Read errors on individual directories are silently ignored.
 */
export async function* walkFiles(dir, { ext = null, skipDirs = [] } = {}) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (skipDirs.includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, { ext, skipDirs });
    else if (e.isFile() && (!ext || e.name.toLowerCase().endsWith(ext))) yield full;
  }
}

/** Parse the opening <svg> tag and return its attributes as a plain object. */
export function parseSvgOpenTag(source) {
  const openTag = (source.match(/<svg\b[^>]*>/i) || [''])[0];
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(openTag)) !== null) attrs[m[1]] = m[2].trim();
  return attrs;
}

/** Parse a viewBox string into { x, y, w, h } or null. */
export function parseViewBox(raw) {
  if (!raw) return null;
  const n = raw.split(/[\s,]+/).map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite)) return null;
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

/** Escape a string for safe interpolation into HTML. */
export const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** ANSI color helpers, disabled when stdout is not a TTY or NO_COLOR is set. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
export const color = {
  red: paint('31'), green: paint('32'), yellow: paint('33'),
  cyan: paint('36'), magenta: paint('35'), bold: paint('1'),
};

/** Returns true if the SVG contains at least one <text> element with content. */
export function hasNonEmptyText(source) {
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (/\S/.test(m[1].replace(/<[^>]+>/g, ''))) return true;
  }
  return false;
}

/** Returns true if the SVG carries any inkscape: or sodipodi: namespaced markup. */
export const hasInkscapeMarkup = (source) => /\b(inkscape|sodipodi):/.test(source);

/** Format bytes as a compact human-readable string (e.g. "1.2 KB"). */
export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
