// svg-tidy.mjs
// Cosmetic SVG cleanup shared by clean-templates.mjs and optimize-svg.mjs.
// See tools/README.md for what it does and why; see the call sites for why
// each tool runs it. Never touches path (`d`) or polygon/polyline
// (`points`) data, and never touches `cx`/`cy`/`r` (see ROUNDED_ATTRS).
// The design-grid snap below operates on viewBox coordinates; the root
// <svg>'s own width/height (display size, set by resize-svg.mjs) are a
// different, independently-scaled coordinate space and are never snapped
// (see isRootSvg / tidyNumericAttrs). On a small viewBox (see
// DEFAULT_MIN_VIEWBOX_DIM) the 2.5-unit grid step is large relative to the
// icon, so the whole numeric snap is skipped for that document - those
// icons are already flagged by audit-svg.mjs's own size warning, and are
// meant to be reviewed and adjusted by hand, not rewritten automatically.

import { DEFAULT_MIN_VIEWBOX_DIM, parseViewBox } from './shared.mjs';

const ROUNDED_ATTRS = ['x', 'y', 'rx', 'ry', 'width', 'height', 'stroke-width', 'font-size'];

function isDoubledHexPair(pair) {
  return pair[0].toLowerCase() === pair[1].toLowerCase();
}

function shortenHexColor(value) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (!m) return value;
  const pairs = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
  if (!pairs.every(isDoubledHexPair)) return value;
  return '#' + pairs.map((p) => p[0]).join('');
}

function tidyColors(el) {
  for (const attr of ['fill', 'stroke']) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const shortened = shortenHexColor(value);
    if (shortened !== value) el.setAttribute(attr, shortened);
  }
}

function snapToDesignGrid(n) {
  const snapped = Math.round(n / 2.5) * 2.5;
  return Number.isInteger(snapped) ? String(snapped) : snapped.toFixed(1);
}

// stroke-width is a thickness, not a position: unlike x/y/rx/ry/width/height
// - where landing exactly on the 0 grid point is a normal, often desired
// result (a square corner, an edge at the origin) - a stroke-width of 0 is
// indistinguishable from no stroke at all. A thin border on a small-viewBox
// icon (e.g. an over-precise 1.0583 from an SVG editor) can land in the
// grid's 0 bucket, so the path stays in the markup but its visible border
// disappears. Snapping is cosmetic and must never silently delete something
// visible, so for this one attribute only, round away from zero instead.
function snapStrokeWidth(n) {
  if (n === 0) return '0';
  const snapped = Math.round(n / 2.5) * 2.5;
  const result = snapped !== 0 ? snapped : (n > 0 ? 2.5 : -2.5);
  return Number.isInteger(result) ? String(result) : result.toFixed(1);
}

// True for the document's root <svg> element only (its parent is the
// document node itself), as opposed to any nested element.
function isRootSvg(el) {
  return el.localName === 'svg' && !!el.parentNode && el.parentNode.nodeType === 9;
}

function tidyNumericAttrs(el) {
  // The root <svg>'s width/height are presentation attributes in *display*
  // units, set independently by resize-svg.mjs (rounded to the nearest
  // 0.25) and often a small fraction of the viewBox. Snapping them to the
  // design grid below mixes two unrelated coordinate spaces and silently
  // distorts the icon's rendered size, so they are left untouched here;
  // every other element's x/y/width/height lives in viewBox coordinates
  // and is fair game.
  const skipWidthHeight = isRootSvg(el);
  for (const attr of ROUNDED_ATTRS) {
    if (skipWidthHeight && (attr === 'width' || attr === 'height')) continue;
    const raw = el.getAttribute(attr);
    if (raw === null) continue;
    const pxMatch = /^(-?[\d.]+)px$/.exec(raw.trim());
    const numStr = pxMatch ? pxMatch[1] : raw.trim();
    const n = Number(numStr);
    if (!Number.isFinite(n)) continue;

    const decimalDigits = (numStr.split('.')[1] || '').length;
    const snap = attr === 'stroke-width' ? snapStrokeWidth : snapToDesignGrid;
    const newValue = decimalDigits <= 1 ? numStr : snap(n);
    if (newValue !== raw) el.setAttribute(attr, newValue);
  }
}

function tidyTextAlign(el) {
  if (el.hasAttribute('text-align')) el.removeAttribute('text-align');
}

function textContentOf(el) {
  let text = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === 3) text += child.data;
    else if (child.nodeType === 1) text += textContentOf(child);
  }
  return text;
}

function tidyXmlSpace(el) {
  if (!el.hasAttribute('xml:space')) return;
  const text = textContentOf(el);
  if (!/^\s|\s$|\s{2,}/.test(text)) el.removeAttribute('xml:space');
}

function hasEffectiveStroke(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentNode) {
    const strokeAttr = node.getAttribute('stroke');
    if (strokeAttr) return strokeAttr.trim().toLowerCase() !== 'none';
    const style = node.getAttribute('style');
    if (style) {
      const m = /(?:^|;)\s*stroke\s*:\s*([^;]+)/i.exec(style);
      if (m) return m[1].trim().toLowerCase() !== 'none';
    }
  }
  return false;
}

const ALWAYS_DEAD_STYLE_RE = /^(?:font-variant-caps|font-variant-east-asian|font-variant-ligatures|font-variant-numeric|line-height)\s*:/i;
const STROKE_ONLY_STYLE_RE = /^paint-order\s*:/i;
const STROKE_ONLY_ATTRS = ['stroke-width', 'stroke-linecap', 'stroke-dasharray'];

function tidyTextStroke(el) {
  const strokeInUse = hasEffectiveStroke(el);

  if (!strokeInUse) {
    for (const attr of STROKE_ONLY_ATTRS) {
      if (el.hasAttribute(attr)) el.removeAttribute(attr);
    }
  }

  const style = el.getAttribute('style');
  if (style === null) return;
  const kept = style
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => {
      if (!decl) return false;
      if (ALWAYS_DEAD_STYLE_RE.test(decl)) return false;
      if (!strokeInUse && STROKE_ONLY_STYLE_RE.test(decl)) return false;
      return true;
    });
  if (kept.length === 0) el.removeAttribute('style');
  else el.setAttribute('style', kept.join(';'));
}

function tidyRedundantTspanPosition(textEl) {
  const tx = textEl.getAttribute('x');
  const ty = textEl.getAttribute('y');
  for (let i = 0; i < textEl.childNodes.length; i++) {
    const child = textEl.childNodes[i];
    if (child.nodeType !== 1 || child.localName !== 'tspan') continue;
    if (tx !== null && child.hasAttribute('x') && Number(child.getAttribute('x')) === Number(tx)) {
      child.removeAttribute('x');
    }
    if (ty !== null && child.hasAttribute('y') && Number(child.getAttribute('y')) === Number(ty)) {
      child.removeAttribute('y');
    }
  }
}

function stripFontVariationSettings(style) {
  return style
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl && !/^font-variation-settings\s*:/i.test(decl))
    .join(';');
}

function cleanStrayStyles(node) {
  if (node.nodeType === 1) {
    const tag = node.localName;
    const style = node.getAttribute && node.getAttribute('style');
    if (style && tag !== 'text' && tag !== 'tspan' && /font-variation-settings/i.test(style)) {
      const cleaned = stripFontVariationSettings(style);
      if (cleaned) node.setAttribute('style', cleaned);
      else node.removeAttribute('style');
    }
  }
  for (let i = 0; i < node.childNodes.length; i++) cleanStrayStyles(node.childNodes[i]);
}

// Post-order: children are fully tidied (including their own numeric
// rounding) before a <text>'s redundant-tspan-position check runs, so that
// check compares already-rounded values on both sides.
function tidyAll(node, skipNumericSnap) {
  for (let i = 0; i < node.childNodes.length; i++) tidyAll(node.childNodes[i], skipNumericSnap);

  if (node.nodeType !== 1) return;
  const tag = node.localName;

  tidyColors(node);
  if (!skipNumericSnap) tidyNumericAttrs(node);

  if (tag === 'text' || tag === 'tspan') {
    tidyTextAlign(node);
    tidyXmlSpace(node);
    tidyTextStroke(node);
  }
  if (tag === 'text') tidyRedundantTspanPosition(node);
}

/** Runs the full tidy pass on a parsed SVG's root element, in place. */
export function tidySvgDocument(root) {
  cleanStrayStyles(root);

  const viewBox = parseViewBox(root.getAttribute('viewBox'));
  const skipNumericSnap = !!viewBox && Math.min(viewBox.w, viewBox.h) < DEFAULT_MIN_VIEWBOX_DIM;

  tidyAll(root, skipNumericSnap);
}
