// icon-composer.mjs
// Builds one SVG from resolved signal features, laid out like the ORM map:
// the icons of a feature are composited like proxy/js/ui.js layoutImages()
// (center/top/bottom/left/right), and the features of a node are stacked in
// one pile, bottom first, centered, with a 2 px gap (proxy/js/styles.mjs
// icon-offset). Several scenes (nodes or tag sets) can be drawn next to
// each other, each with its name below. Every feature is its own <g>, every
// icon a nested <svg> keeping its own viewBox.

import fs from 'node:fs';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const FEATURE_GAP = 2;
const SCENE_GAP = 20;
const MARGIN = 5;
const LABEL_SIZE = 4;
const LABEL_HEIGHT = 8;
const LABEL_CHAR_WIDTH = 2.4;
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

// Lays out the pile of one scene: returns its size and a function drawing
// it at a given origin.
function layoutScene(features, symbolsRoot, deactivatedIcon) {
  const blocks = features.map((feature) => {
    const loaded = feature.icons.map((icon) => ({ ...loadIcon(symbolsRoot, icon.id), position: icon.position }));
    return { feature, ...layoutIcons(loaded) };
  });
  const width = Math.max(0, ...blocks.map((b) => b.width));
  const height = blocks.reduce((sum, b) => sum + b.height, 0) + FEATURE_GAP * Math.max(0, blocks.length - 1);

  const draw = (x, y, prefix, featureAttrs) => {
    const parts = [];
    let bottom = y + height;
    blocks.forEach(({ feature, icons, width: w, height: h }, index) => {
      const x0 = x + (width - w) / 2;
      const y0 = bottom - h;
      parts.push(`<g id="${prefix}feature-${index}-${escapeXml(feature.type ?? 'unknown')}"${featureAttrs}><title>${escapeXml(feature.description)}</title>`);
      icons.forEach((icon) => parts.push(iconMarkup(icon, x0 + icon.x, y0 + icon.y)));
      if (feature.deactivated) {
        parts.push(iconMarkup(deactivatedIcon, x0 + (w - deactivatedIcon.width) / 2, y0 + (h - deactivatedIcon.height) / 2));
      }
      parts.push('</g>');
      bottom = y0 - FEATURE_GAP;
    });
    return parts.join('');
  };

  return { width, height, draw };
}

/**
 * Renders scenes side by side, bottom-aligned, into one SVG document.
 * @param {Array<{name: string, features: Array}>} scenes
 *                                     Features (bottom first) come from matchSignals().
 * @param {string} symbolsRoot         The symbols/ folder.
 * @param {{scale: number, title: string, background: string|null, labels: boolean}} options
 *                                     A background also adds a shadow under each feature.
 */
export function composeSvg(scenes, symbolsRoot, { scale, title, background, labels }) {
  const deactivatedIcon = loadIcon(symbolsRoot, DEACTIVATED_ICON);
  const laidOut = scenes.map((scene) => {
    const layout = layoutScene(scene.features, symbolsRoot, deactivatedIcon);
    // Each scene gets a slot wide enough for its label.
    const slot = labels ? Math.max(layout.width, scene.name.length * LABEL_CHAR_WIDTH) : layout.width;
    return { ...scene, ...layout, slot };
  });
  const labelHeight = labels ? LABEL_HEIGHT : 0;

  const contentWidth = laidOut.reduce((sum, s) => sum + s.slot, 0) + SCENE_GAP * Math.max(0, laidOut.length - 1);
  const contentHeight = Math.max(0, ...laidOut.map((s) => s.height));
  const totalWidth = contentWidth + 2 * MARGIN;
  const totalHeight = contentHeight + labelHeight + 2 * MARGIN;

  const parts = [];
  if (background) parts.push(`<defs>${SHADOW_FILTER}</defs><rect width="100%" height="100%" fill="${escapeXml(background)}"/>`);
  const featureAttrs = background ? ' filter="url(#shadow)"' : '';
  let left = MARGIN;
  laidOut.forEach((scene, index) => {
    const prefix = laidOut.length > 1 ? `s${index}-` : '';
    parts.push(`<g id="scene-${index}"><title>${escapeXml(scene.name)}</title>`);
    parts.push(scene.draw(left + (scene.slot - scene.width) / 2, MARGIN + contentHeight - scene.height, prefix, featureAttrs));
    if (labels) {
      parts.push(`<text x="${left + scene.slot / 2}" y="${MARGIN + contentHeight + LABEL_HEIGHT - 2}" font-family="${LABEL_FONT}" font-size="${LABEL_SIZE}" text-anchor="middle" fill="#333">${escapeXml(scene.name)}</text>`);
    }
    parts.push('</g>');
    left += scene.slot + SCENE_GAP;
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\r\n'
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth * scale}" height="${totalHeight * scale}" viewBox="0 0 ${totalWidth} ${totalHeight}">`
    + `<title>${escapeXml(title)}</title>${parts.join('')}</svg>\r\n`;
}
