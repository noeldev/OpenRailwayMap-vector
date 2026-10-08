#!/usr/bin/env node
// generate-aspects.mjs
//
// Generates digit/number overlay (or, for a fused-icon family, whole-plate)
// SVG files and light signal aspect overlays from hand-authored template
// SVGs, driven entirely by a JSON job list (see aspects/spec.json). No
// per-family script needed: add a job to the JSON and re-run.
//
// Each job runs in one of five modes (job.mode, default "split"):
//   split   - the usual case: a shape-only base plus one text-only overlay
//             file per slot per value, composited together by the renderer.
//             Handles both a single centered number and several stacked
//             slots (e.g. "top"/"bottom").
//   digits  - like split, but a template's several <text> elements together
//             spell out ONE number (one element per digit) rather than each
//             belonging to its own independent slot; one overlay file per
//             value, all its digits set at once.
//   fused   - for a family whose YAML icon has only ONE state to show, so a
//             separate base+overlay pair would be pointless (and would show
//             the digits floating with no shape under them if ever viewed
//             standalone): shape and number always end up in the same file,
//             one self-contained file per value, plus an optional "empty"
//             shape-only placeholder for when no value is selected. Works
//             with a single <text> element (whole value as one string, e.g.
//             the L... train-length plates) or several (one digit per
//             element, left-to-right, e.g. a box's per-glyph digit display -
//             same per-element assignment as "digits" mode, just without
//             stripping the shape away first).
//   lights  - light signal target: the template tags its lamps with class
//             tokens (the aspects lighting them); produces an unlit base,
//             one layer per aspect and part, plus flattened examples
//             (optionally with a deactivated cross). See runLightsJob().
//   compose - flattens existing icons from the symbols tree (e.g. a box
//             and its lettering overlays) into one example file, for the
//             YAML exampleIcon of a feature whose icon is only a stack of
//             layers. See runComposeJob().
//
// A template's <text> elements are found anywhere in the tree (not just as
// direct children of <svg>), and a split job assigns them to slots by
// vertical position (lowest y first = "top") rather than by document order,
// since templates don't always declare their text elements top-to-bottom. A
// job's "slots" array must therefore list slot names top-to-bottom too.
//
// A split job may set "textByLength": attributes applied to its text for
// values of a given number of characters, e.g. { "3": { "y": 820,
// "font-size": 400 } } for 3-digit speeds. One template then covers every
// value of a family (base and overlays share the same drawing).
//
// Split and digits jobs may set "example": a value (or, for a multi-slot
// split job, { slot: value }) flattened onto the base into the group's
// examples folder, under the base's own name, for a YAML exampleIcon.
//
// Generated filenames always wrap the numeric value in literal braces, e.g.
// "TIV-D_diamond_{50}_bottom.svg", matching the project's on-disk naming
// convention - without the braces the renderer will not find the file.
//
// A <text> element lifted out of its template may have been relying on
// presentation attributes (font-family, text-anchor, stroke-width, ...) and
// transforms set on an ancestor <g> rather than on itself. Since that
// ancestor is not part of the standalone overlay file, those inherited
// values are resolved and copied onto the extracted element so it renders
// identically on its own (see inlineInheritedPresentation()).
//
// Usage:
//   node generate-aspects.mjs (--group <names> | --all) [options]
//
// Job selection (one is required):
//   --group <names>     Comma-separated template groups (first folder of a
//                        job's template path: signs, boards, boxes, signals)
//   --all               Every job
//
// Options:
//   --spec <file>       JSON job spec (default: tools/aspects/spec.json)
//   --templates <dir>   Template root directory (default: tools/aspects/templates)
//   --symbols <dir>     Icon tree read by "compose" jobs (default: symbols/fr)
//   --out <dir>         Output root directory
//                        (default: a fresh folder under the OS temp directory -
//                        a real symbols/fr tree is only ever touched if --out
//                        is given explicitly, so a careless re-run can never
//                        overwrite hand-reconstructed icons)
//   -h, --help          Show this help

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

import { TOOLS_DIR, DEFAULT_SVG_ROOT, color } from './lib/shared.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_SPEC = path.join(TOOLS_DIR, 'aspects', 'spec.json');
const DEFAULT_TEMPLATES_DIR = path.join(TOOLS_DIR, 'aspects', 'templates');

const HELP = `
Usage: node tools/generate-aspects.mjs (--group <names> | --all) [options]

Job selection (one is required):
  --group <names>     Comma-separated template groups to process, i.e. the
                      first folder of each job's template path
                      (signs, boards, boxes, signals)
  --all               Process every job

Options:
  --spec <file>       JSON job spec (default: ${path.relative(TOOLS_DIR, DEFAULT_SPEC)})
  --templates <dir>   Template root directory (default: ${path.relative(TOOLS_DIR, DEFAULT_TEMPLATES_DIR)})
  --symbols <dir>     Icon tree read by "compose" jobs (default: ${path.relative(TOOLS_DIR, DEFAULT_SVG_ROOT)})
  --out <dir>         Output root directory (default: a fresh temp folder -
                      pass this explicitly to write into the real symbols/fr tree)
  -h, --help          Show this help
`;

// Presentation attributes that SVG treats as inherited. When a <text>
// element is lifted out of its ancestor <g>, whichever of these it does not
// already define itself must be copied down from that ancestor, or the
// standalone file will not render the way it did nested in the template
// (e.g. a lost text-anchor="middle" shifts the text off-center).
const INHERITABLE_ATTRS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
  'letter-spacing', 'word-spacing', 'direction', 'writing-mode',
  'xml:space', 'style',
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeSvgFile(filePath, svgElement) {
  const xml = new XMLSerializer().serializeToString(svgElement);
  // CRLF line endings with a final CRLF, matching the project's file
  // delivery convention for every generated file, not just hand-edited ones.
  const content = '<?xml version="1.0" encoding="UTF-8"?>\r\n' + xml + '\r\n';
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { encoding: 'utf8' });
}

function createSvgRoot(doc, template) {
  const root = doc.createElementNS(SVG_NS, 'svg');
  root.setAttribute('version', template.getAttribute('version') || '1.1');
  const viewBox = template.getAttribute('viewBox');
  if (viewBox) root.setAttribute('viewBox', viewBox);
  return root;
}

// Finds every <text> element anywhere under `node` (not just direct
// children), since a template may group its text inside a <g>.
function findTextElements(node, out = []) {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType !== 1) continue;
    if (child.localName === 'text') out.push(child);
    else findTextElements(child, out);
  }
  return out;
}

// Returns a clone of `template`'s tree with every <text> element removed,
// wherever it is nested.
function cloneWithoutText(doc, node) {
  const clone = node.cloneNode(false);
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType === 1) {
      if (child.localName === 'text') continue;
      clone.appendChild(cloneWithoutText(doc, child));
    } else {
      clone.appendChild(child.cloneNode(true));
    }
  }
  return clone;
}

// Finds a <tspan> child of `textElement`, if any - most templates put their
// value there, but some (e.g. the 2-digit V sign) put it directly as the
// <text> element's own text content instead.
function findTspan(textElement) {
  for (let i = 0; i < textElement.childNodes.length; i++) {
    const child = textElement.childNodes[i];
    if (child.nodeType === 1 && child.localName === 'tspan') return child;
  }
  return null;
}

// Clears every child text node of `node` and appends a single new one.
function setTextContent(node, value) {
  while (node.firstChild) node.removeChild(node.firstChild);
  node.appendChild(node.ownerDocument.createTextNode(String(value)));
}

// Sets the displayed value of a <text> element, wherever it actually lives
// (its <tspan> child, or its own text content). Only the digit run already
// there is replaced - any surrounding literal text (e.g. "L" and "RBT" in
// "L 200 RBT") is left untouched, so a template can mix fixed wording with
// the substituted value. A template whose text is nothing but the value
// (e.g. "90") still works the same way: the whole string is itself the
// digit run being replaced. The template's own placeholder number is
// otherwise never used for anything, so it can be any value in range.
function setDisplayValue(textElement, value) {
  const node = findTspan(textElement) || textElement;
  const current = node.textContent;
  if (!/\d/.test(current)) {
    throw new Error(`no digit found to substitute in text "${current}"`);
  }
  setTextContent(node, current.replace(/\d+/, String(value)));
}

// Reads the "y" attribute off a <text> element, or its own <tspan> if the
// text element doesn't carry one itself (both styles appear in the wild).
function textY(textElement) {
  const own = textElement.getAttribute('y');
  if (own !== null) return parseFloat(own);
  const tspan = findTspan(textElement);
  const tspanY = tspan ? tspan.getAttribute('y') : null;
  return tspanY !== null ? parseFloat(tspanY) : 0;
}

// Returns `element`'s ancestor chain as an array, root-most element first,
// stopping at (and including) `root`.
function getAncestorChain(element, root) {
  const chain = [];
  let node = element.parentNode;
  while (node && node.nodeType === 1) {
    chain.push(node);
    if (node === root) break;
    node = node.parentNode;
  }
  return chain.reverse();
}

// Merges two "prop: value; ..." style strings into one, `override`'s
// declarations winning per-property over `base`'s.
function mergeStyle(base, override) {
  const parse = (s) => {
    const map = new Map();
    for (const decl of (s || '').split(';')) {
      const [k, v] = decl.split(':').map((part) => part && part.trim());
      if (k && v) map.set(k, v);
    }
    return map;
  };
  const merged = parse(base);
  for (const [k, v] of parse(override)) merged.set(k, v);
  return Array.from(merged, ([k, v]) => `${k}:${v}`).join(';');
}

// Resolves everything `textElement` was inheriting from its ancestors in the
// template and bakes it onto its standalone `clone`, so the clone renders
// identically once those ancestors are gone. Returns the node to insert into
// the overlay file: `clone` itself, or `clone` wrapped in <g> element(s)
// reproducing any ancestor transforms (root-most outermost, matching the
// original nesting).
function inlineInheritedPresentation(textElement, clone, template) {
  const chain = getAncestorChain(textElement, template);

  // Root-most first, so a closer ancestor's (or the element's own) value
  // correctly takes precedence over a farther one's, same as CSS inheritance.
  for (const ancestor of chain) {
    for (const attr of INHERITABLE_ATTRS) {
      const value = ancestor.getAttribute(attr);
      if (value === null) continue;
      if (attr === 'style') {
        clone.setAttribute('style', mergeStyle(value, clone.getAttribute('style')));
      } else if (clone.getAttribute(attr) === null) {
        clone.setAttribute(attr, value);
      }
    }
  }

  // Transforms are not inherited, they compose: rebuild the nesting with <g>
  // wrappers instead, closest-to-text processed first so the root-most
  // ancestor's transform ends up outermost, exactly as in the template.
  let wrapped = clone;
  for (let i = chain.length - 1; i >= 0; i--) {
    const transform = chain[i].getAttribute('transform');
    if (!transform) continue;
    const g = clone.ownerDocument.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', transform);
    g.appendChild(wrapped);
    wrapped = g;
  }
  return wrapped;
}

// Examples (flattened composites used by the YAML exampleIcon) of every
// mode go to an "examples" folder at the root of the job's output group,
// e.g. "signs/examples" for base "signs/V_split".
const exampleDirOf = (job) => path.join((job.base ?? job.layers[0]).split(/[\\/]/)[0], 'examples');

// A job's group is the first folder of its template path (or, for a
// "compose" job, of its first layer), e.g. "signals" for "signals/C.svg".
const groupOf = (job) => (job.template ?? job.layers[0]).split(/[\\/]/)[0];

// Renders a job's filename template. Recognized tokens:
//   {name}  - job.name
//   {v}     - the numeric value, wrapped in the literal braces the renderer
//             expects on disk (e.g. 50 -> "{50}")
//   {slot}  - the slot name (only meaningful for a non-centered slot)
// Most families use the default "{name}_{v}" / "{name}_{v}_{slot}" shape
// (e.g. "TIV-D_B_{100}", "TIV-D_diamond_{50}_bottom"), but some put the
// value first instead (e.g. the V vehicle-count signs: "{5}V"), hence this
// being configurable per job via `job.fileName` rather than hardcoded.
function renderFileName(fileNameTemplate, name, value, slot) {
  return fileNameTemplate
    .replace(/\{name\}/g, name)
    .replace(/\{v\}/g, `{${value}}`)
    .replace(/\{slot\}/g, slot || '');
}

// Shape-only root of a template: the template with every <text> element
// stripped, wherever nested.
function buildBaseRoot(doc, template) {
  const baseRoot = createSvgRoot(doc, template);
  const strippedChildren = cloneWithoutText(doc, template).childNodes;
  for (let i = 0; i < strippedChildren.length; i++) {
    baseRoot.appendChild(strippedChildren[i].cloneNode(true));
  }
  return baseRoot;
}

// Writes the job's example: the base with the given text nodes flattened
// onto it, in the group's examples folder under the base's own name.
function writeExample(job, baseRoot, nodes, outRoot) {
  const exampleRoot = baseRoot.cloneNode(true);
  nodes.forEach((node) => exampleRoot.appendChild(node));
  writeSvgFile(path.join(outRoot, exampleDirOf(job), `${path.basename(job.base)}.svg`), exampleRoot);
}

// Applies job.textByLength to a text clone, for the length of the value it
// displays (e.g. the smaller font of a 3-digit speed).
function applyTextByLength(job, textClone, displayValue) {
  const attrs = job.textByLength?.[String(displayValue).length];
  for (const [name, value] of Object.entries(attrs ?? {})) textClone.setAttribute(name, String(value));
}

/**
 * Runs one "split" job (the default mode): extracts the base (shape, no
 * text) and, for each declared slot (top-to-bottom by vertical position),
 * one overlay file per value.
 *
 * @param {object} job
 * @param {string} job.name          Used in the console summary and in the
 *                                   default filename templates.
 * @param {string} job.template      Path to the template SVG.
 * @param {string} job.base          Output path (no extension) for the
 *                                   shape-only base file.
 * @param {string} job.overlayDir    Directory overlay files are written
 *                                   into.
 * @param {string[]} [job.slots]     Slot names, top-to-bottom. Defaults to
 *                                   ["centered"] for a 1-text template or
 *                                   ["slot0", "slot1", ...] for more.
 * @param {number[]} [job.values]    Values shared by every slot.
 * @param {Record<string, number[]>} [job.valuesBySlot]
 *                                   Per-slot values, when slots don't share
 *                                   the same range (overrides `values`).
 * @param {number} [job.displayDivisor]
 *                                   When set, the tspan shows
 *                                   Math.floor(value / displayDivisor)
 *                                   instead of the raw value, while the
 *                                   filename still uses the raw value (e.g.
 *                                   TIV pentagonal signs: a 30 km/h sign is
 *                                   named ..._{30}.svg but only ever shows
 *                                   the tens digit, "3").
 * @param {Record<string, object>} [job.textByLength]
 *                                   Text attributes per value length (see
 *                                   applyTextByLength).
 * @param {string} [job.fileName]    Overlay filename template (see
 *                                   renderFileName). Defaults to
 *                                   "{name}_{v}" for a centered slot or
 *                                   "{name}_{v}_{slot}" otherwise.
 * @param {number|Record<string, number>} [job.example]
 *                                   Example value(s), see writeExample. An
 *                                   empty `values` list with an example
 *                                   writes a second base of the same drawing
 *                                   (e.g. a mobile TIV sharing the overlays
 *                                   of the fixed one).
 * @param {string} outRoot           Root directory job paths are relative to.
 */
function runSplitJob(job, outRoot) {
  const xml = fs.readFileSync(job.template, 'utf8');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const template = doc.documentElement;

  const textElements = findTextElements(template).sort((a, b) => textY(a) - textY(b));
  if (textElements.length === 0) {
    throw new Error(`${job.template}: no <text> element found`);
  }

  const slotNames = job.slots || (textElements.length === 1 ? ['centered'] : textElements.map((_, i) => `slot${i}`));
  if (slotNames.length !== textElements.length) {
    throw new Error(
      `${job.template}: found ${textElements.length} <text> element(s) but ${slotNames.length} slot name(s) were given`
    );
  }

  const baseRoot = buildBaseRoot(doc, template);
  writeSvgFile(path.join(outRoot, `${job.base}.svg`), baseRoot);

  // Builds the node to insert for one slot's text element at one value:
  // a clone with its display value set and its inherited presentation/
  // transforms resolved, same treatment whether it ends up in a standalone
  // overlay file or composited straight onto an example icon.
  function buildOverlayNode(textElement, value) {
    const textClone = textElement.cloneNode(true);
    const displayValue = job.displayDivisor
      ? Math.floor(value / job.displayDivisor)
      : value;
    setDisplayValue(textClone, displayValue);
    applyTextByLength(job, textClone, displayValue);
    return inlineInheritedPresentation(textElement, textClone, template);
  }

  // Overlays: one text-only file per slot per value.
  let overlayCount = 0;
  textElements.forEach((textElement, index) => {
    const slot = slotNames[index];
    const values = (job.valuesBySlot && job.valuesBySlot[slot]) || job.values;
    if (!values) throw new Error(`${job.template}: no values configured for slot "${slot}"`);

    for (const value of values) {
      const root = createSvgRoot(doc, template);
      root.appendChild(buildOverlayNode(textElement, value));

      const defaultTemplate = slot === 'centered' ? '{name}_{v}' : '{name}_{v}_{slot}';
      const name = renderFileName(job.fileName || defaultTemplate, job.name, value, slot);
      writeSvgFile(path.join(outRoot, job.overlayDir, `${name}.svg`), root);
      overlayCount += 1;
    }
  });

  // Optional example: job.example is a single value for a one-slot
  // ("centered") job, or { slotName: value, ... } for a multi-slot one.
  let exampleCount = 0;
  if (job.example !== undefined) {
    const nodes = textElements.map((textElement, index) => {
      const slot = slotNames[index];
      const value = typeof job.example === 'object' ? job.example[slot] : job.example;
      if (value === undefined) {
        throw new Error(`${job.template}: job.example has no value for slot "${slot}"`);
      }
      return buildOverlayNode(textElement, value);
    });
    writeExample(job, baseRoot, nodes, outRoot);
    exampleCount = 1;
  }

  console.log(
    `${job.name} (${path.basename(job.template)}): base + ${overlayCount} overlay(s)` +
    (exampleCount ? ' + example' : '')
  );
  return 1 + overlayCount + exampleCount;
}

/**
 * Runs one "digits" job: like a split job, but all of a template's <text>
 * elements together spell out ONE number (e.g. the "{19}V" sign draws its
 * "1" and "9" as two separately-positioned <text> elements rather than one
 * <text> with a 2-character tspan). Every value therefore produces a SINGLE
 * overlay file carrying all the digit elements at once, left-to-right,
 * rather than one file per slot.
 *
 * Takes the same options as a split job except `slots`/`valuesBySlot` and
 * `textByLength`, which do not apply: all text elements of a given overlay
 * always show different digits of the very same value.
 */
function runDigitsJob(job, outRoot) {
  const xml = fs.readFileSync(job.template, 'utf8');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const template = doc.documentElement;

  // Digits are laid out left-to-right, not stacked, so sort by x rather than
  // the y-based ordering a split job uses.
  const textElements = findTextElements(template).sort((a, b) => {
    const ax = parseFloat(a.getAttribute('x') || '0');
    const bx = parseFloat(b.getAttribute('x') || '0');
    return ax - bx;
  });
  if (textElements.length < 2) {
    throw new Error(`${job.template}: "digits" mode expects 2+ <text> elements, found ${textElements.length}`);
  }

  const baseRoot = buildBaseRoot(doc, template);
  writeSvgFile(path.join(outRoot, `${job.base}.svg`), baseRoot);

  // Digit nodes of one value, left-to-right.
  const buildDigitNodes = (value) => {
    const digits = String(value).split('');
    if (digits.length !== textElements.length) {
      throw new Error(
        `${job.template}: value ${value} has ${digits.length} digit(s) but the template has ${textElements.length} digit slot(s)`
      );
    }
    return textElements.map((textElement, index) => {
      const textClone = textElement.cloneNode(true);
      setDisplayValue(textClone, digits[index]);
      return inlineInheritedPresentation(textElement, textClone, template);
    });
  };

  for (const value of job.values) {
    const root = createSvgRoot(doc, template);
    buildDigitNodes(value).forEach((node) => root.appendChild(node));
    const name = renderFileName(job.fileName || '{name}_{v}', job.name, value);
    writeSvgFile(path.join(outRoot, job.overlayDir, `${name}.svg`), root);
  }

  const exampleCount = job.example !== undefined ? 1 : 0;
  if (exampleCount) writeExample(job, baseRoot, buildDigitNodes(job.example), outRoot);

  console.log(`${job.name} (${path.basename(job.template)}): base + ${job.values.length} overlay(s)` + (exampleCount ? ' + example' : ''));
  return 1 + job.values.length + exampleCount;
}

/**
 * Runs one "fused" job: unlike split/digits jobs, the shape and the number
 * are NOT separated into a base plus overlay(s) - each value instead
 * produces one self-contained file (the template as-is, with its tspan
 * value substituted), matching an existing fused-icon family's on-disk
 * convention (e.g. the L... train-length plates: "L{170}.svg" is the whole
 * plate, not a base plus a "{170}" overlay).
 *
 * `job.base`, when given, is still written as the shape with its text
 * stripped - used by these families as the "nothing selected" placeholder
 * icon (e.g. "L_empty.svg"), not as a layer meant to be composited with the
 * numbered files.
 *
 * A template with exactly 1 <text> element gets the whole (possibly
 * displayDivisor-adjusted) value written into it as one string, same as a
 * split job's single-slot case. A template with 2+ <text> elements (e.g. a
 * SNCF-Lightbox box digit display, one glyph per element) gets one digit
 * per element instead, assigned left-to-right by x position exactly like a
 * "digits" job - except the shape is kept rather than stripped, since the
 * whole point of "fused" is one self-contained file per value.
 *
 * job.displayDivisor works the same as in a split job: the filename and
 * job.values always carry the raw value, only the text shown is divided.
 */
function runFusedJob(job, outRoot) {
  const xml = fs.readFileSync(job.template, 'utf8');

  let count = 0;
  if (job.base) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    writeSvgFile(path.join(outRoot, `${job.base}.svg`), buildBaseRoot(doc, doc.documentElement));
    count += 1;
  }

  for (const value of job.values) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    const textElements = findTextElements(root);
    const displayValue = job.displayDivisor ? Math.floor(value / job.displayDivisor) : value;

    if (textElements.length === 1) {
      setDisplayValue(textElements[0], displayValue);
    } else if (textElements.length > 1) {
      const sorted = textElements.slice().sort((a, b) => {
        const ax = parseFloat(a.getAttribute('x') || '0');
        const bx = parseFloat(b.getAttribute('x') || '0');
        return ax - bx;
      });
      const digits = String(displayValue).split('');
      if (digits.length !== sorted.length) {
        throw new Error(
          `${job.template}: value ${value} has ${digits.length} digit(s) but the template has ${sorted.length} <text> element(s)`
        );
      }
      sorted.forEach((textElement, index) => setDisplayValue(textElement, digits[index]));
    } else {
      throw new Error(`${job.template}: "fused" mode expects at least 1 <text> element, found 0`);
    }

    const name = renderFileName(job.fileName || '{name}_{v}', job.name, value);
    writeSvgFile(path.join(outRoot, job.overlayDir, `${name}.svg`), root);
    count += 1;
  }

  console.log(`${job.name} (${path.basename(job.template)}): ${job.base ? 'base + ' : ''}${job.values.length} file(s)`);
  return count;
}

// Collects every element under `node` for which `predicate` is true.
function findElements(node, predicate, out = []) {
  for (let i = 0; i < node.childNodes.length; i++) {
    const child = node.childNodes[i];
    if (child.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    findElements(child, predicate, out);
  }
  return out;
}

// Removes the class tokens (and comments) from `node`'s whole subtree:
// they only drive the generator and mean nothing to the renderer.
function stripTokens(node) {
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i];
    if (child.nodeType === 8) node.removeChild(child);
    else if (child.nodeType === 1) stripTokens(child);
  }
  if (node.nodeType === 1) node.removeAttribute('class');
}

// Class tokens of an element.
const tokensOf = (el) => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);

// Parses "x y w h" into numbers.
function readViewBox(template) {
  const parts = (template.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error('template has no valid viewBox');
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

const round = (n) => Math.round(n * 1000) / 1000;

// Creates an <svg> root with an explicit viewBox. Like every other mode,
// width/height are left to resize-svg.mjs, which derives them from the
// viewBox, so all layers of a target keep the same scale.
function createViewBoxRoot(doc, viewBox) {
  const root = doc.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', [viewBox.x, viewBox.y, viewBox.w, viewBox.h].map(round).join(' '));
  return root;
}

// Clones `element` (optionally refilled) without its tokens, wrapped in
// whatever ancestor transforms it had in the template.
function buildLayerNode(element, template, fill) {
  const clone = element.cloneNode(true);
  if (fill) clone.setAttribute('fill', fill);
  stripTokens(clone);
  return inlineInheritedPresentation(element, clone, template);
}

// St Andrew's cross of a deactivated signal: two bars joining the corners of
// a width x height box centered on (cx, cy). Offsets are rounded to whole
// units, so the points stay on integer (or half, for a .5 center) values.
function buildCrossPath(doc, { cx, cy, width, height, thickness }) {
  const w = Math.round(width / 2);
  const h = Math.round(height / 2);
  const half = (thickness * Math.hypot(w, h)) / 2;
  const a = Math.round(half / h);
  const b = Math.round(half / w);
  const points = [
    [-(w - a), -h], [-w, -(h - b)], [-a, 0], [-w, h - b], [-(w - a), h], [0, b],
    [w - a, h], [w, h - b], [a, 0], [w, -(h - b)], [w - a, -h], [0, -b],
  ];
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', '#fff');
  path.setAttribute('stroke', '#000');
  path.setAttribute('stroke-width', '2.5');
  path.setAttribute('d', 'M' + points.map(([x, y]) => `${cx + x} ${cy + y}`).join('L') + 'Z');
  return path;
}

// Smallest viewBox containing the cross and centered like the base, since
// the renderer composites layers center-on-center. Half sizes snap up to 5
// units, keeping the size on the 10-unit icon grid.
function centeredViewBoxContaining(base, { cx, cy, width, height }) {
  const stroke = 1.25;
  const snap = (n) => Math.ceil(n / 5) * 5;
  const centerX = base.x + base.w / 2;
  const centerY = base.y + base.h / 2;
  const halfW = Math.max(base.w / 2, snap(Math.abs(cx - centerX) + width / 2 + stroke));
  const halfH = Math.max(base.h / 2, snap(Math.abs(cy - centerY) + height / 2 + stroke));
  return { x: centerX - halfW, y: centerY - halfH, w: halfW * 2, h: halfH * 2 };
}

// Lit color of a token for one element: either a plain color, or a color
// per element name when one token lights several shapes differently.
function litColor(colors, token, el) {
  const color = colors[token];
  return typeof color === 'string' ? color : color?.[el.localName];
}

// Example-only layer name drawing the job's deactivated cross.
const DEACTIVATED_LAYER = 'deactivated';

/**
 * Runs one "lights" job: an unlit base plus stackable layers.
 *
 * Template elements carry class tokens: the aspects that light them
 * (class="S C"), the clearing light token, or a part token (job.parts)
 * for equipment only some signal types have, written as its own layer.
 *
 * @param {object} job
 * @param {string} job.name          Target name, prefix of every layer file.
 * @param {string} job.template      Template SVG path.
 * @param {string} job.base          Base output path (no extension).
 * @param {string} job.overlayDir    Layer output directory.
 * @param {string[]} [job.parts]     Tokens written as "<name>-<token>" layers.
 * @param {Record<string, string>} job.aspects
 *                                   Aspect name -> "+"-joined tokens.
 * @param {{cx: number, cy: number, width: number, height: number, thickness: number}} [job.deactivated]
 *                                   Cross drawn by the "deactivated" example
 *                                   layer (no file: the map overlays its own
 *                                   cross, the example is for exampleIcon).
 * @param {string[][]} [job.examples]
 *                                   Layer lists flattened onto the base, named
 *                                   "<name>-<layer>..." (parts not named).
 * @param {object} spec              Spec root: lightColors, clearingLight.
 * @param {string} outRoot           Output root directory.
 */
function runLightsJob(job, spec, outRoot) {
  const colors = spec.lightColors;
  const clearing = spec.clearingLight;
  const xml = fs.readFileSync(job.template, 'utf8');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const template = doc.documentElement;
  const viewBox = readViewBox(template);

  const partTokens = job.parts || [];
  const tokenElements = findElements(template, (el) => tokensOf(el).length > 0);
  const isPart = (el) => tokensOf(el).some((token) => partTokens.includes(token));
  const withToken = (token) => tokenElements.filter((el) => tokensOf(el).includes(token));
  const clearingElements = withToken(clearing.token);

  const requireToken = (token, usedBy) => {
    if (withToken(token).length === 0) throw new Error(`${job.template}: ${usedBy} uses token "${token}" but no element has that class`);
  };

  // Layer builders by name: nodes are built on demand, since a node can
  // only be inserted once. Every layer shares the template viewBox.
  const layers = new Map();

  for (const token of partTokens) {
    requireToken(token, `part "${token}"`);
    layers.set(token, () => withToken(token).map((el) => buildLayerNode(el, template)));
  }

  for (const [name, expression] of Object.entries(job.aspects)) {
    const tokens = expression.split('+');
    for (const token of tokens) {
      requireToken(token, `aspect "${name}"`);
      for (const el of withToken(token)) {
        if (!litColor(colors, token, el)) throw new Error(`${job.template}: no color for token "${token}" on <${el.localName}>`);
      }
    }
    const litBy = (el) => tokensOf(el).find((token) => tokens.includes(token));
    const clearingLit = !tokens.some((token) => clearing.offWith.includes(token));
    layers.set(name, () => [
      ...tokenElements
        .filter((el) => !isPart(el) && litBy(el))
        .map((el) => buildLayerNode(el, template, litColor(colors, litBy(el), el))),
      ...(clearingLit ? clearingElements.map((el) => buildLayerNode(el, template, clearing.color)) : []),
    ]);
  }

  // Base: everything unlit, without the parts.
  const baseRoot = template.cloneNode(true);
  findElements(baseRoot, isPart).forEach((el) => el.parentNode.removeChild(el));
  stripTokens(baseRoot);
  writeSvgFile(path.join(outRoot, `${job.base}.svg`), baseRoot);

  for (const [name, build] of layers) {
    const root = createViewBoxRoot(doc, viewBox);
    build().forEach((node) => root.appendChild(node));
    writeSvgFile(path.join(outRoot, job.overlayDir, `${job.name}-${name}.svg`), root);
  }

  // Examples: all layers share the base coordinates, so flattening is a
  // concatenation.
  const examples = job.examples || [];
  const names = new Set();
  for (const layerNames of examples) {
    const name = [job.name, ...layerNames.filter((layerName) => !partTokens.includes(layerName))].join('-');
    if (names.has(name)) throw new Error(`${job.template}: two examples are both named "${name}"`);
    names.add(name);
    const withCross = layerNames.includes(DEACTIVATED_LAYER);
    if (withCross && !job.deactivated) throw new Error(`${job.template}: example "${name}" needs job.deactivated`);
    const selected = layerNames.filter((layerName) => layerName !== DEACTIVATED_LAYER).map((layerName) => {
      const layer = layers.get(layerName);
      if (!layer) throw new Error(`${job.template}: example "${name}" uses unknown layer "${layerName}"`);
      return layer;
    });
    if (withCross) selected.push(() => [buildCrossPath(doc, job.deactivated)]);
    const root = createViewBoxRoot(doc, withCross ? centeredViewBoxContaining(viewBox, job.deactivated) : viewBox);
    const unlit = baseRoot.cloneNode(true);
    while (unlit.firstChild) root.appendChild(unlit.firstChild);
    selected.forEach((build) => build().forEach((node) => root.appendChild(node)));
    writeSvgFile(path.join(outRoot, exampleDirOf(job), `${name}.svg`), root);
  }

  console.log(`${job.name} (${path.basename(job.template)}): base + ${layers.size} layer(s) + ${examples.length} example(s)`);
  return 1 + layers.size + examples.length;
}

/**
 * Runs one "compose" job: flattens existing icons into one example file,
 * each layer centered on the first one, the way the renderer composites
 * "center" layers.
 *
 * @param {object} job
 * @param {string} job.name          Example file name (no extension), in
 *                                   the group's examples folder.
 * @param {string[]} job.layers      Icon paths relative to the symbols
 *                                   tree, without extension, bottom first.
 * @param {string} symbolsRoot       Icon tree the layers are read from.
 * @param {string} outRoot           Root directory job paths are relative to.
 */
function runComposeJob(job, symbolsRoot, outRoot) {
  const layers = job.layers.map((layer) => {
    const file = path.join(symbolsRoot, `${layer}.svg`);
    if (!fs.existsSync(file)) throw new Error(`compose "${job.name}": layer not found: ${file}`);
    const svg = new DOMParser().parseFromString(fs.readFileSync(file, 'utf8'), 'text/xml').documentElement;
    return { svg, viewBox: readViewBox(svg) };
  });

  const width = Math.max(...layers.map((layer) => layer.viewBox.w));
  const height = Math.max(...layers.map((layer) => layer.viewBox.h));
  const doc = layers[0].svg.ownerDocument;
  const root = createViewBoxRoot(doc, { x: 0, y: 0, w: width, h: height });

  for (const { svg, viewBox } of layers) {
    const g = doc.createElementNS(SVG_NS, 'g');
    const dx = (width - viewBox.w) / 2 - viewBox.x;
    const dy = (height - viewBox.h) / 2 - viewBox.y;
    if (dx || dy) g.setAttribute('transform', `translate(${round(dx)} ${round(dy)})`);
    while (svg.firstChild) g.appendChild(svg.firstChild);
    root.appendChild(g);
  }

  writeSvgFile(path.join(outRoot, exampleDirOf(job), `${job.name}.svg`), root);
  console.log(`${job.name} (compose): ${job.layers.length} layer(s)`);
  return 1;
}

function runJob(job, spec, outRoot, symbolsRoot) {
  const mode = job.mode || 'split';
  if (mode === 'split') return runSplitJob(job, outRoot);
  if (mode === 'digits') return runDigitsJob(job, outRoot);
  if (mode === 'fused') return runFusedJob(job, outRoot);
  if (mode === 'lights') return runLightsJob(job, spec, outRoot);
  if (mode === 'compose') return runComposeJob(job, symbolsRoot, outRoot);
  throw new Error(`Unknown job mode: ${mode}`);
}

function parseArgs(argv) {
  const opts = { spec: DEFAULT_SPEC, templates: DEFAULT_TEMPLATES_DIR, symbols: DEFAULT_SVG_ROOT, out: null, groups: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--spec') opts.spec = argv[++i];
    else if (a === '--templates') opts.templates = argv[++i];
    else if (a === '--symbols') opts.symbols = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--group') opts.groups = (argv[++i] || '').split(',').map((g) => g.trim()).filter(Boolean);
    else if (a === '--all') opts.all = true;
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else { console.error(color.red(`Unknown option: ${a}`)); console.log(HELP); process.exit(1); }
  }
  if (!opts.all && !opts.groups?.length) {
    console.error(color.red('Specify --group <names> or --all'));
    console.log(HELP);
    process.exit(1);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Safe-by-default output: unless --out is given explicitly, generate into
  // a fresh temp folder rather than risking an overwrite of a real,
  // hand-reconstructed symbols/fr tree.
  const usingTempOut = !opts.out;
  const outDir = opts.out || fs.mkdtempSync(path.join(os.tmpdir(), 'svg-aspects-'));

  if (!fs.existsSync(opts.spec)) {
    console.error(color.red(`ERROR: spec file not found: ${opts.spec}`));
    process.exit(1);
  }
  if (!fs.existsSync(opts.templates)) {
    console.error(color.red(`ERROR: templates directory not found: ${opts.templates}`));
    process.exit(1);
  }

  console.log(color.cyan(`Spec      : ${opts.spec}`));
  console.log(color.cyan(`Templates : ${opts.templates}`));
  console.log(color.cyan(`Symbols   : ${opts.symbols}`));
  console.log(color.cyan(`Groups    : ${opts.all ? 'all' : opts.groups.join(', ')}`));
  console.log(usingTempOut
    ? color.yellow(`Output    : ${outDir}  (temporary - pass --out <dir> to write elsewhere)`)
    : color.cyan(`Output    : ${outDir}`));
  console.log();

  const spec = JSON.parse(fs.readFileSync(opts.spec, 'utf8'));
  const known = new Set(spec.jobs.map(groupOf));
  const unknown = (opts.groups || []).filter((g) => !known.has(g));
  if (unknown.length) {
    console.error(color.red(`Unknown group(s): ${unknown.join(', ')} (known: ${[...known].join(', ')})`));
    process.exit(1);
  }
  const jobs = opts.all ? spec.jobs : spec.jobs.filter((job) => opts.groups.includes(groupOf(job)));

  let total = 0;
  for (const job of jobs) {
    const resolved = job.template ? { ...job, template: path.join(opts.templates, job.template) } : job;
    total += runJob(resolved, spec, outDir, opts.symbols);
  }
  console.log();
  console.log(color.green(`Total files generated: ${total}`));
  if (usingTempOut) {
    console.log(color.yellow(`Review the files in ${outDir}, then copy what you need into symbols/fr yourself.`));
  }
}

main();
