#!/usr/bin/env node
// resize-svg.mjs
//
// Adjust the width/height attributes of SVG files based on their viewBox.
// The scale is expressed as a percentage of the viewBox dimensions.
// Output dimensions are rounded to the nearest 0.25.
// The viewBox attribute is never modified.
//
// Usage:
//   node tools/resize-svg.mjs                          # dry-run, boxes/
//   node tools/resize-svg.mjs --apply
//   node tools/resize-svg.mjs --subdir signals --apply
//   node tools/resize-svg.mjs --subdir boards --scale 2.5 --apply
//
// The target folder is always <project>/symbols/fr/<subdir>.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_SVG_ROOT, color } from './lib/shared.mjs';

const HELP = `
Usage: node tools/resize-svg.mjs [options]

Options:
  --subdir <name>    Subfolder under symbols/fr (default: boxes)
  --scale  <percent> Scale applied to the viewBox (default: 2.5)
  --apply            Write changes to disk (default: dry-run)
  -h, --help         Show this help
`;

const argv = process.argv.slice(2);
const opts = { apply: false, subdir: 'boxes', scale: 2.5 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--apply') opts.apply = true;
  else if (a === '--subdir') opts.subdir = argv[++i];
  else if (a === '--scale') opts.scale = Number(argv[++i]);
  else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  else { console.error('Unknown option: ' + a); process.exit(1); }
}

const svgDir = join(DEFAULT_SVG_ROOT, opts.subdir);

if (!existsSync(svgDir)) {
  console.error(color.red(`ERROR: directory not found: ${svgDir}`));
  process.exit(1);
}

console.log(color.cyan(`Target : ${svgDir}`));
console.log(color.cyan(`Scale  : ${opts.scale}%`));
console.log(color.cyan(`Mode   : ${opts.apply ? 'APPLY' : 'DRY-RUN'}`));
console.log();

const roundQuarter = (v) => Math.round(v * 4) / 4;
const scale = opts.scale / 100;

const entries = await readdir(svgDir, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.svg')) continue;

  const filePath = join(svgDir, entry.name);
  const raw = await readFile(filePath, 'utf8');

  const vbMatch = raw.match(/<svg[^>]*\bviewBox="([^"]+)"/);
  if (!vbMatch) {
    console.warn(`WARN: no viewBox found: ${entry.name}`);
    continue;
  }

  const viewBox = vbMatch[1];
  const parts = viewBox.trim().split(/\s+/);
  const vbW = Number(parts[2]);
  const vbH = Number(parts[3]);
  const newW = roundQuarter(vbW * scale);
  const newH = roundQuarter(vbH * scale);

  const tagMatch = raw.match(/<svg\b[^>]*>/s);
  if (!tagMatch) {
    console.warn(`WARN: could not parse <svg> tag: ${entry.name}`);
    continue;
  }

  const oldTag = tagMatch[0];
  let newTag = oldTag
    .replace(/\s+width="[^"]*"/, '')
    .replace(/\s+height="[^"]*"/, '');

  const insert = ` width="${newW}" height="${newH}"`;
  newTag = /\bviewBox="[^"]*"/.test(newTag)
    ? newTag.replace(/(\bviewBox="[^"]*")/, insert + ' $1')
    : newTag.replace(/>$/, insert + '>');

  const updated = raw.replace(oldTag, newTag);

  const prefix = opts.apply ? '' : '[DRY] ';
  console.log(`${prefix}${entry.name.padEnd(55)} viewBox=${viewBox.padEnd(22)} -> ${newW} x ${newH}  (${opts.scale}%)`);

  if (opts.apply) {
    await writeFile(filePath, updated, 'utf8');
  }
}