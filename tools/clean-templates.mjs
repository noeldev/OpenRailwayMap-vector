#!/usr/bin/env node
// clean-templates.mjs
//
// Resolves (removes) transform="..." attributes left on the hand-drawn
// aspect templates (tools/aspects/templates/**/*.svg), WITHOUT reshaping
// anything else in the file.
//
// This intentionally does NOT run SVGO. SVGO's preset-default always
// includes convertShapeToPath, which rewrites every <circle>/<rect>/
// <polygon>/<polyline> into <path> arc/line commands - even ones that
// never carried a transform to begin with. That is backwards for a
// hand-maintained template library: a readable primitive
// (circle cx="20" cy="115" r="5") is strictly better to look at and edit
// than the equivalent path data, and most shapes in these templates have
// no transform at all. So this tool resolves transforms itself with
// plain affine-matrix geometry, touches only the element that actually
// carries a transform, and leaves every other element - its tag, its
// attributes, their order - exactly as drawn.
//
// Resolution rules, per element that has a transform:
//   - <polygon>/<polyline>: every point is transformed directly (exact
//     for translate, scale, rotate, skew or matrix - a polygon is just a
//     point list, so there is no shape to lose).
//   - <line>: both endpoints are transformed the same way.
//   - <rect>: the 4 corners are transformed. A pure translate keeps it as
//     <rect> with x/y shifted (no shape change needed). Anything else
//     (rotate, skew, a non-uniform matrix) turns it into a <polygon> of
//     the 4 transformed corners - a transformed rectangle is a
//     parallelogram in the general case, e.g. rotate(45) turning a square
//     into a diamond, and a polygon represents that exactly and stays a
//     plain, readable primitive instead of becoming a path.
//   - <circle>/<ellipse>: a pure translate shifts cx/cy; a pure
//     (uniform, for circle) scale also scales the radius. Anything that
//     includes rotation or skew, or a non-uniform scale on a circle,
//     cannot be represented by a plain circle/ellipse without a
//     transform - that case is reported instead of guessed (none of the
//     current templates hit it).
//   - <text>/<tspan>: a near-identity scale/matrix (Inkscape nudge noise,
//     within IDENTITY_EPSILON) is dropped; anything else is reported -
//     text layout can't be baked into transform-free geometry the way a
//     shape's coordinates can.
//   - any other element, or a transform this tool doesn't recognize
//     (skewX/skewY composed with something else, an unparsable function):
//     reported, never guessed at.
//
// On top of transform resolution, this tool also runs the shared cosmetic
// "tidy" pass from ./lib/svg-tidy.mjs (hex color shortening, px-stripping
// and design-grid rounding, dead text attribute/style removal - see that
// file for the exact rules). optimize-svg.mjs runs the same pass on
// symbols/fr for the same reason.
//
// Templates are written with CRLF line endings and a final CRLF, like every
// other file in the project (the XML parser normalizes line breaks inside
// the document to LF, so they are converted back). Only files that
// actually changed are rewritten, with a pristine backup under
// tools/_backup/aspects-templates/.
//
// Usage:
//   node tools/clean-templates.mjs              # writes in place, with backup
//   node tools/clean-templates.mjs --no-backup

import fs from 'node:fs';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

import { TOOLS_DIR, color, walkFiles } from './lib/shared.mjs';
import { tidySvgDocument } from './lib/svg-tidy.mjs';

const TEMPLATES_DIR = path.join(TOOLS_DIR, 'aspects', 'templates');
const BACKUP_DIR = path.join(TOOLS_DIR, '_backup', 'aspects-templates');

// A transform this close to identity is Inkscape floating-point noise, not
// intended geometry - e.g. "scale(1.0001 .99992)" left over from a nudge.
const IDENTITY_EPSILON = 0.001;

const HELP = `
Usage: node tools/clean-templates.mjs [options]

Options:
  --no-backup   Skip the pristine-copy backup before overwriting a template
  -h, --help    Show this help
`;

function parseArgs(argv) {
  const opts = { backup: true, help: false };
  for (const a of argv) {
    if (a === '--no-backup') opts.backup = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

// ----- Affine matrix helpers -------------------------------------------
// A matrix is [a, b, c, d, e, f] meaning point' = (a*x + c*y + e, b*x + d*y + f),
// the same convention as the SVG "matrix(a b c d e f)" transform function.

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(m, x, y) {
  const [a, b, c, d, e, f] = m;
  return [a * x + c * y + e, b * x + d * y + f];
}

// Parses a full transform="..." value (one or more functions) into a
// single combined matrix, or null if any function isn't recognized.
function parseTransformList(value) {
  const fnRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let matrix = IDENTITY;
  let match;
  let any = false;
  while ((match = fnRe.exec(value))) {
    const name = match[1];
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let m;
    if (name === 'translate') {
      const [tx, ty = 0] = args;
      m = [1, 0, 0, 1, tx, ty];
    } else if (name === 'scale') {
      const [sx, sy = sx] = args;
      m = [sx, 0, 0, sy, 0, 0];
    } else if (name === 'rotate') {
      const [deg, cx = 0, cy = 0] = args;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot = [cos, sin, -sin, cos, 0, 0];
      m = (cx || cy) ? multiply(multiply([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]) : rot;
    } else if (name === 'skewX') {
      m = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
    } else if (name === 'skewY') {
      m = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
    } else if (name === 'matrix' && args.length === 6) {
      m = args;
    } else {
      return null;
    }
    matrix = multiply(matrix, m);
    any = true;
  }
  return any ? matrix : null;
}

function isNearIdentity(m) {
  const [a, b, c, d, e, f] = m;
  return (
    Math.abs(a - 1) < IDENTITY_EPSILON && Math.abs(b) < IDENTITY_EPSILON &&
    Math.abs(c) < IDENTITY_EPSILON && Math.abs(d - 1) < IDENTITY_EPSILON &&
    Math.abs(e) < IDENTITY_EPSILON && Math.abs(f) < IDENTITY_EPSILON
  );
}

// A matrix with no rotation/skew component: a pure translate+scale.
function isAxisAligned(m) {
  return Math.abs(m[1]) < IDENTITY_EPSILON && Math.abs(m[2]) < IDENTITY_EPSILON;
}

function isPureTranslate(m) {
  return isAxisAligned(m) && Math.abs(m[0] - 1) < IDENTITY_EPSILON && Math.abs(m[3] - 1) < IDENTITY_EPSILON;
}

// Trims to 5 decimal places, matching the precision already used by hand
// in these templates.
function fmtNum(n) {
  return String(Math.round(n * 1e5) / 1e5);
}

function parsePoints(value) {
  const nums = value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i], nums[i + 1]]);
  return points;
}

function formatPoints(points) {
  return points.map(([x, y]) => `${fmtNum(x)} ${fmtNum(y)}`).join(' ');
}

// ----- Transform resolution, per element type ---------------------------

function renameElement(el, newTag) {
  const doc = el.ownerDocument;
  const replacement = doc.createElementNS(el.namespaceURI, newTag);
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes.item(i);
    replacement.setAttribute(attr.name, attr.value);
  }
  el.parentNode.replaceChild(replacement, el);
  return replacement;
}

// Resolves one element's transform in place. Returns true if resolved
// (transform removed), false if reported instead (left untouched).
function resolveElementTransform(el, remaining) {
  const tag = el.localName;
  const transformValue = el.getAttribute('transform');
  const matrix = parseTransformList(transformValue);

  if (matrix === null) {
    remaining.push({ tag, transform: transformValue, reason: 'unrecognized transform function' });
    return false;
  }

  if (tag === 'text' || tag === 'tspan') {
    if (isNearIdentity(matrix)) {
      el.removeAttribute('transform');
      return true;
    }
    remaining.push({ tag, transform: transformValue, reason: 'text geometry, not identity-noise' });
    return false;
  }

  if (tag === 'polygon' || tag === 'polyline') {
    const points = parsePoints(el.getAttribute('points') || '');
    const transformed = points.map(([x, y]) => applyMatrix(matrix, x, y));
    el.setAttribute('points', formatPoints(transformed));
    el.removeAttribute('transform');
    return true;
  }

  if (tag === 'line') {
    const x1 = parseFloat(el.getAttribute('x1'));
    const y1 = parseFloat(el.getAttribute('y1'));
    const x2 = parseFloat(el.getAttribute('x2'));
    const y2 = parseFloat(el.getAttribute('y2'));
    const [nx1, ny1] = applyMatrix(matrix, x1, y1);
    const [nx2, ny2] = applyMatrix(matrix, x2, y2);
    el.setAttribute('x1', fmtNum(nx1));
    el.setAttribute('y1', fmtNum(ny1));
    el.setAttribute('x2', fmtNum(nx2));
    el.setAttribute('y2', fmtNum(ny2));
    el.removeAttribute('transform');
    return true;
  }

  if (tag === 'rect') {
    const x = parseFloat(el.getAttribute('x') || '0');
    const y = parseFloat(el.getAttribute('y') || '0');
    const w = parseFloat(el.getAttribute('width'));
    const h = parseFloat(el.getAttribute('height'));

    if (isPureTranslate(matrix)) {
      el.setAttribute('x', fmtNum(x + matrix[4]));
      el.setAttribute('y', fmtNum(y + matrix[5]));
      el.removeAttribute('transform');
      return true;
    }

    // General case (rotate/skew/non-uniform scale): a transformed rect is
    // a parallelogram - represent it exactly as a <polygon>, which stays a
    // plain, readable primitive instead of becoming path data.
    if (el.hasAttribute('rx') || el.hasAttribute('ry')) {
      remaining.push({ tag, transform: transformValue, reason: 'rounded rect, cannot become an exact polygon' });
      return false;
    }
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      .map(([cx, cy]) => applyMatrix(matrix, cx, cy));
    el.removeAttribute('x');
    el.removeAttribute('y');
    el.removeAttribute('width');
    el.removeAttribute('height');
    el.removeAttribute('transform');
    const polygon = renameElement(el, 'polygon');
    polygon.setAttribute('points', formatPoints(corners));
    return true;
  }

  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseFloat(el.getAttribute('cx') || '0');
    const cy = parseFloat(el.getAttribute('cy') || '0');

    if (isPureTranslate(matrix)) {
      el.setAttribute('cx', fmtNum(cx + matrix[4]));
      el.setAttribute('cy', fmtNum(cy + matrix[5]));
      el.removeAttribute('transform');
      return true;
    }

    if (isAxisAligned(matrix)) {
      const sx = matrix[0];
      const sy = matrix[3];
      const [ncx, ncy] = applyMatrix(matrix, cx, cy);
      if (tag === 'circle') {
        const r = parseFloat(el.getAttribute('r'));
        el.removeAttribute('transform');
        if (Math.abs(sx - sy) < IDENTITY_EPSILON) {
          el.setAttribute('cx', fmtNum(ncx));
          el.setAttribute('cy', fmtNum(ncy));
          el.setAttribute('r', fmtNum(r * sx));
          return true;
        }
        // Non-uniform scale turns a circle into an axis-aligned ellipse.
        el.removeAttribute('r');
        const ellipse = renameElement(el, 'ellipse');
        ellipse.setAttribute('cx', fmtNum(ncx));
        ellipse.setAttribute('cy', fmtNum(ncy));
        ellipse.setAttribute('rx', fmtNum(r * sx));
        ellipse.setAttribute('ry', fmtNum(r * sy));
        return true;
      }
      // ellipse
      const rx = parseFloat(el.getAttribute('rx'));
      const ry = parseFloat(el.getAttribute('ry'));
      el.setAttribute('cx', fmtNum(ncx));
      el.setAttribute('cy', fmtNum(ncy));
      el.setAttribute('rx', fmtNum(rx * sx));
      el.setAttribute('ry', fmtNum(ry * sy));
      el.removeAttribute('transform');
      return true;
    }

    remaining.push({ tag, transform: transformValue, reason: 'rotation/skew on a circle or ellipse - not representable without a transform' });
    return false;
  }

  remaining.push({ tag, transform: transformValue, reason: 'unhandled element type' });
  return false;
}

// Walks the whole tree, resolving every transform found. A resolved
// rect/circle may be replaced in place (renamed to polygon/ellipse) by
// resolveElementTransform; that replacement keeps the same children, so
// collecting the child list up front keeps the walk correct either way.
function resolveAllTransforms(node, remaining) {
  if (node.nodeType === 1 && node.getAttribute('transform')) {
    resolveElementTransform(node, remaining);
  }
  const children = [];
  for (let i = 0; i < node.childNodes.length; i++) children.push(node.childNodes[i]);
  for (const child of children) resolveAllTransforms(child, remaining);
}

function cleanOne(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');

  const doc = new DOMParser().parseFromString(original, 'text/xml');

  const remaining = [];
  resolveAllTransforms(doc.documentElement, remaining);
  tidySvgDocument(doc.documentElement);

  const cleaned = new XMLSerializer().serializeToString(doc.documentElement);
  const content = ('<?xml version="1.0" encoding="UTF-8"?>\n' + cleaned + '\n').replace(/\r?\n/g, '\r\n');
  const changed = content !== original;

  return { content, changed, remaining, original };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error(color.red(`ERROR: templates directory not found: ${TEMPLATES_DIR}`));
    return 1;
  }

  console.log(color.cyan(`Templates: ${TEMPLATES_DIR}`));
  console.log(color.cyan(`Backup   : ${opts.backup ? BACKUP_DIR : 'disabled (--no-backup)'}`));
  console.log();

  let cleaned = 0;
  let unchanged = 0;
  const stillHasTransform = [];

  for await (const filePath of walkFiles(TEMPLATES_DIR, { ext: '.svg' })) {
    const rel = path.relative(TEMPLATES_DIR, filePath).split(path.sep).join('/');
    const { content, changed, remaining, original } = cleanOne(filePath);

    if (changed) {
      if (opts.backup) {
        const backupPath = path.join(BACKUP_DIR, rel);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, original, 'utf8');
      }
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(color.green(`  cleaned   ${rel}`));
      cleaned++;
    } else {
      unchanged++;
    }
    if (remaining.length > 0) stillHasTransform.push({ rel, remaining });
  }

  console.log();
  console.log(color.cyan('===== Summary ====='));
  console.log(color.green(`  Cleaned   : ${cleaned}`));
  console.log(`  Unchanged : ${unchanged}`);
  if (stillHasTransform.length === 0) {
    console.log(color.green('  Remaining transforms: none'));
  } else {
    console.log(color.yellow(`  Remaining transforms: ${stillHasTransform.length} file(s) - review by hand:`));
    for (const { rel, remaining } of stillHasTransform) {
      for (const { tag, transform, reason } of remaining) {
        console.log(color.yellow(`    ${rel}: <${tag} transform="${transform}"> (${reason})`));
      }
    }
  }

  return 0;
}

process.exitCode = await main();
