// icon-composer.mjs
// Builds one SVG from resolved signal features, laid out like the ORM map:
// the icons of a feature are composited like proxy/js/ui.js layoutImages()
// (center/top/bottom/left/right), the features of a row (inline features)
// are placed side by side, vertically centered, with a 2 px gap (ui.js
// generateImage()), and the rows of a node are stacked in one pile, bottom
// first, centered, with a 2 px gap (proxy/js/styles.mjs icon-offset). Several scenes (nodes or tag sets) are drawn side by side,
// each with its name below, and wrap to a new row past a maximum width.
// Every row of scenes, scene and row of features is its own <g>, every icon a nested <svg>
// keeping its own viewBox.

import fs from 'node:fs';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const FEATURE_GAP = 2;
const ROW_FEATURE_GAP = 2;
const SCENE_GAP = 20;
const ROW_GAP = 15;
const MARGIN = 5;
const LABEL_SIZE = 4;
const LABEL_LINE_HEIGHT = 5;
const LABEL_TOP = 3;
const LABEL_CHAR_WIDTH = 2.2;
// Narrowest label column, in characters, whatever the scene width.
const LABEL_MIN_CHARS = 18;
// Common fonts first: a bare sans-serif may resolve to a symbol font.
const LABEL_FONT = 'Arial, Helvetica, DejaVu Sans, sans-serif';
const DEACTIVATED_ICON = 'general/signal-deactivated';

// Soft shadow under each feature, so white edges stand out on a background.
const SHADOW_FILTER = '<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">'
  + '<feDropShadow dx="0.3" dy="0.4" stdDeviation="0.4" flood-color="#000" flood-opacity="0.45"/></filter>';

const escapeXml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

// Loads an icon and its display size in px (width/height attributes, or the
// viewBox at the usual 2.5 % scale when resize has not run yet).
function loadIcon(symbolsRoot, id) {
  let file = path.join(symbolsRoot, `${id}.svg`);
  // Not every signal type has its own "unknown" icon: use the generic one.
  if (!fs.existsSync(file) && id.startsWith('general/signal-unknown-')) file = path.join(symbolsRoot, 'general/signal-unknown.svg');
  // A missing file is drawn as the unknown signal icon, so the rest of the
  // node still renders.
  if (!fs.existsSync(file)) {
    console.warn(`WARNING: icon not found: ${id}`);
    file = path.join(symbolsRoot, 'general/signal-unknown.svg');
  }
  const svg = new DOMParser().parseFromString(fs.readFileSync(file, 'utf8'), 'text/xml').documentElement;
  const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const width = parseFloat(svg.getAttribute('width')) || viewBox[2] * 0.025;
  const height = parseFloat(svg.getAttribute('height')) || viewBox[3] * 0.025;
  return { id, svg, width, height };
}

// Port of ui.js layoutImages(): offsets of every image, the first one fixed.
// Like the original, a "left" image is shifted by half its width only, and
// the canvas keeps the accumulated size when it exceeds the bounding box.
function layoutIcons(icons) {
  let width = icons[0].width;
  let height = icons[0].height;
  const global = { x: 0, y: 0 };
  const placed = icons.map((icon) => ({ ...icon, x: 0, y: 0 }));

  for (const image of placed.slice(1)) {
    switch (image.position) {
      case 'center':
        image.x = global.x + width / 2 - image.width / 2;
        image.y = global.y + height / 2 - image.height / 2;
        width = Math.max(width, image.width);
        height = Math.max(height, image.height);
        break;
      case 'bottom':
        image.x = global.x + width / 2 - image.width / 2;
        image.y = global.y + height;
        width = Math.max(width, image.width);
        height += image.height;
        break;
      case 'top':
        image.x = global.x + width / 2 - image.width / 2;
        image.y = global.y - image.height;
        width = Math.max(width, image.width);
        height += image.height;
        break;
      case 'right':
        image.x = global.x + width;
        image.y = global.y + height / 2 - image.height / 2;
        width += image.width;
        height = Math.max(height, image.height);
        break;
      case 'left':
        image.x = global.x - image.width / 2;
        image.y = global.y + height / 2 - image.height / 2;
        width += image.width;
        height = Math.max(height, image.height);
        break;
    }
    global.x = Math.min(global.x, image.x);
    global.y = Math.min(global.y, image.y);
  }

  for (const image of placed) {
    image.x -= global.x;
    image.y -= global.y;
    width = Math.max(width, image.x + image.width);
    height = Math.max(height, image.y + image.height);
  }
  return { icons: placed, width, height };
}

// Nested <svg> for one icon at (x, y), keeping its own viewBox.
function iconMarkup(icon, x, y) {
  const svg = icon.svg.cloneNode(true);
  for (const attr of ['x', 'y', 'width', 'height']) svg.removeAttribute(attr);
  svg.setAttribute('x', String(x));
  svg.setAttribute('y', String(y));
  svg.setAttribute('width', String(icon.width));
  svg.setAttribute('height', String(icon.height));
  return new XMLSerializer().serializeToString(svg).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '');
}

// Lays out a row of features side by side, vertically centered: the icons
// of every feature with their offsets in the row.
function layoutRow(row, symbolsRoot) {
  const members = row.members.map((feature) => {
    const loaded = feature.icons.map((icon) => ({ ...loadIcon(symbolsRoot, icon.id), position: icon.position }));
    return layoutIcons(loaded);
  });
  const height = Math.max(...members.map((m) => m.height));
  let width = -ROW_FEATURE_GAP;
  const icons = members.flatMap((member) => {
    const x0 = width + ROW_FEATURE_GAP;
    const y0 = (height - member.height) / 2;
    width = x0 + member.width;
    return member.icons.map((icon) => ({ ...icon, x: x0 + icon.x, y: y0 + icon.y }));
  });
  return { row, icons, width, height };
}

// Lays out the pile of one scene: returns its size and a function drawing
// it at a given origin.
function layoutScene(rows, symbolsRoot, deactivatedIcon) {
  const blocks = rows.map((row) => layoutRow(row, symbolsRoot));
  const width = Math.max(0, ...blocks.map((b) => b.width));
  const height = blocks.reduce((sum, b) => sum + b.height, 0) + FEATURE_GAP * Math.max(0, blocks.length - 1);

  const draw = (x, y, prefix, featureAttrs) => {
    const parts = [];
    let bottom = y + height;
    blocks.forEach(({ row, icons, width: w, height: h }, index) => {
      const x0 = x + (width - w) / 2;
      const y0 = bottom - h;
      const types = row.members.map((f) => f.type ?? 'unknown').join('+');
      const title = row.members.map((f) => f.description).join(', ');
      parts.push(`<g id="${prefix}feature-${index}-${escapeXml(types)}"${featureAttrs}><title>${escapeXml(title)}</title>`);
      icons.forEach((icon) => parts.push(iconMarkup(icon, x0 + icon.x, y0 + icon.y)));
      if (row.deactivated) {
        parts.push(iconMarkup(deactivatedIcon, x0 + (w - deactivatedIcon.width) / 2, y0 + (h - deactivatedIcon.height) / 2));
      }
      parts.push('</g>');
      bottom = y0 - FEATURE_GAP;
    });
    return parts.join('');
  };

  return { width, height, draw };
}

// Splits a label into lines of about `maxChars` characters, at spaces.
function wrapLabel(text, maxChars) {
  const lines = [];
  for (const word of text.split(/\s+/)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= maxChars) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

// Greedy packing of scene slots into rows no wider than `maxWidth` (0: one row).
function packRows(items, maxWidth) {
  const rows = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    const width = row ? row.width + SCENE_GAP + item.slot : item.slot;
    if (row && (maxWidth <= 0 || width <= maxWidth)) {
      row.items.push(item);
      row.width = width;
    } else {
      rows.push({ items: [item], width: item.slot });
    }
  }
  for (const row of rows) {
    row.height = Math.max(...row.items.map((item) => item.height));
    row.labelHeight = Math.max(...row.items.map((item) => item.labelHeight));
  }
  return rows;
}

/**
 * Renders scenes side by side into one SVG document, in rows wrapped at
 * `maxWidth`. Scenes of a row share the same baseline (the signal anchor).
 * @param {Array<{name: string, rows: Array}>} scenes
 *                                     Rows (bottom first) come from groupRows().
 * @param {string} symbolsRoot         The symbols/ folder.
 * @param {{scale: number, title: string, background: string|null, labels: boolean, maxWidth: number}} options
 *                                     A background also adds a shadow under each
 *                                     feature. maxWidth is in map pixels, 0 for one row.
 */
export function composeSvg(scenes, symbolsRoot, { scale, title, background, labels, maxWidth }) {
  const deactivatedIcon = loadIcon(symbolsRoot, DEACTIVATED_ICON);
  const laidOut = scenes.map((scene) => {
    const layout = layoutScene(scene.rows, symbolsRoot, deactivatedIcon);
    // The label wraps to the scene width, with a minimum column.
    const maxChars = Math.max(LABEL_MIN_CHARS, Math.floor(layout.width / LABEL_CHAR_WIDTH));
    const lines = labels ? wrapLabel(scene.name, maxChars) : [];
    const labelWidth = Math.max(0, ...lines.map((line) => line.length)) * LABEL_CHAR_WIDTH;
    const labelHeight = lines.length ? LABEL_TOP + lines.length * LABEL_LINE_HEIGHT : 0;
    return { ...scene, ...layout, lines, labelHeight, slot: Math.max(layout.width, labelWidth) };
  });
  const rows = packRows(laidOut, maxWidth);

  const contentWidth = Math.max(...rows.map((row) => row.width));
  const contentHeight = rows.reduce((sum, row) => sum + row.height + row.labelHeight, 0) + ROW_GAP * (rows.length - 1);
  const totalWidth = contentWidth + 2 * MARGIN;
  const totalHeight = contentHeight + 2 * MARGIN;

  const parts = [];
  if (background) parts.push(`<defs>${SHADOW_FILTER}</defs><rect width="100%" height="100%" fill="${escapeXml(background)}"/>`);
  const featureAttrs = background ? ' filter="url(#shadow)"' : '';
  const multiple = laidOut.length > 1;
  let top = MARGIN;
  let index = 0;
  rows.forEach((row, rowIndex) => {
    const baseline = top + row.height;
    parts.push(`<g id="row-${rowIndex}">`);
    let left = MARGIN;
    for (const scene of row.items) {
      const prefix = multiple ? `s${index}-` : '';
      parts.push(`<g id="scene-${index}"><title>${escapeXml(scene.name)}</title>`);
      parts.push(scene.draw(left + (scene.slot - scene.width) / 2, baseline - scene.height, prefix, featureAttrs));
      scene.lines.forEach((line, lineIndex) => {
        const y = baseline + LABEL_TOP + (lineIndex + 1) * LABEL_LINE_HEIGHT - 1;
        parts.push(`<text x="${left + scene.slot / 2}" y="${y}" font-family="${LABEL_FONT}" font-size="${LABEL_SIZE}" text-anchor="middle" fill="#333">${escapeXml(line)}</text>`);
      });
      parts.push('</g>');
      left += scene.slot + SCENE_GAP;
      index += 1;
    }
    parts.push('</g>');
    top = baseline + row.labelHeight + ROW_GAP;
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\r\n'
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth * scale}" height="${totalHeight * scale}" viewBox="0 0 ${totalWidth} ${totalHeight}">`
    + `<title>${escapeXml(title)}</title>${parts.join('')}</svg>\r\n`;
}
