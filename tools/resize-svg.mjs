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
//   node tools/resize-svg.mjs --all --apply            # every subdir, one pass
//   node tools/resize-svg.mjs --apply --no-backup
//
// The target folder is <project>/symbols/fr/<subdir>, or the whole
// <project>/symbols/fr tree when --all is given instead of --subdir. Either
// way the walk is recursive, so nested families (e.g. boxes/single/,
// boxes/TIV/) are always included, not just files directly in the folder.
//
// Files are backed up on first modification and never overwritten, so the
// pristine originals are always preserved - same convention as
// optimize-svg.mjs: tools/_backup/<subdir>/ for a --subdir run, or plain
// tools/_backup/ (mirroring the full symbols/fr layout) for --all. See
// .gitignore in this folder.

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  DEFAULT_SVG_ROOT,
  TOOLS_DIR,
  color,
  walkFiles,
  parseSvgOpenTag,
  parseViewBox,
} from './lib/shared.mjs';

const BACKUP_DIR_NAME = '_backup';

const HELP = `
Usage: node tools/resize-svg.mjs [options]

Options:
  --subdir <name>    Subfolder under symbols/fr (default: boxes)
  --all              Process the whole symbols/fr tree instead of one
                     --subdir (every family, recursively, in one pass)
  --scale  <percent> Scale applied to the viewBox (default: 2.5)
  --apply            Write changes to disk (default: dry-run)
  --no-backup        Skip the pristine-copy backup when applying
  -h, --help         Show this help
`;

function parseArgs(argv) {
  const opts = { apply: false, subdir: 'boxes', subdirGiven: false, all: false, scale: 2.5, backup: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--no-backup') opts.backup = false;
    else if (a === '--all') opts.all = true;
    else if (a === '--subdir') { opts.subdir = argv[++i]; opts.subdirGiven = true; }
    else if (a === '--scale') opts.scale = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.all && opts.subdirGiven) throw new Error('--all and --subdir are mutually exclusive');
  return opts;
}

const roundQuarter = (v) => Math.round(v * 4) / 4;

// Rebuilds the opening <svg ...> tag with width/height set (or replaced) just
// before viewBox, leaving every other attribute - and their original order -
// untouched.
function buildTag(openTag, attrs, newW, newH) {
  const kept = { ...attrs };
  delete kept.width;
  delete kept.height;

  const parts = [];
  for (const [key, value] of Object.entries(kept)) {
    if (key === 'viewBox') parts.push(`width="${newW}"`, `height="${newH}"`);
    parts.push(`${key}="${value}"`);
  }
  if (!('viewBox' in kept)) parts.push(`width="${newW}"`, `height="${newH}"`);

  const selfClosing = /\/>\s*$/.test(openTag);
  return `<svg ${parts.join(' ')}${selfClosing ? ' />' : '>'}`;
}

async function backupFile(filePath, rootDir, backupDir) {
  const relPath = relative(rootDir, filePath);
  const backupPath = join(backupDir, relPath);
  await mkdir(join(backupPath, '..'), { recursive: true });
  if (!existsSync(backupPath)) await copyFile(filePath, backupPath);
  return backupPath;
}

async function resizeOne(filePath, svgDir, backupDir, opts) {
  const raw = await readFile(filePath, 'utf8');
  const rel = relative(svgDir, filePath).split(sep).join('/');

  const attrs = parseSvgOpenTag(raw);
  const viewBox = parseViewBox(attrs.viewBox);
  if (!viewBox) {
    console.warn(color.yellow(`WARN: no viewBox found: ${rel}`));
    return 'warned';
  }

  const newW = roundQuarter(viewBox.w * (opts.scale / 100));
  const newH = roundQuarter(viewBox.h * (opts.scale / 100));

  const openTagMatch = raw.match(/<svg\b[^>]*>/s);
  if (!openTagMatch) {
    console.warn(color.yellow(`WARN: could not parse <svg> tag: ${rel}`));
    return 'warned';
  }

  const newTag = buildTag(openTagMatch[0], attrs, newW, newH);
  const updated = raw.slice(0, openTagMatch.index) + newTag + raw.slice(openTagMatch.index + openTagMatch[0].length);

  const prefix = opts.apply ? '' : '[DRY] ';
  console.log(`${prefix}${rel.padEnd(55)} viewBox=${attrs.viewBox.padEnd(22)} -> ${newW} x ${newH}  (${opts.scale}%)`);

  if (opts.apply) {
    if (opts.backup) await backupFile(filePath, svgDir, backupDir);
    await writeFile(filePath, updated, 'utf8');
  }
  return 'resized';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const svgDir = opts.all ? DEFAULT_SVG_ROOT : join(DEFAULT_SVG_ROOT, opts.subdir);
  const backupDir = opts.all ? join(TOOLS_DIR, BACKUP_DIR_NAME) : join(TOOLS_DIR, BACKUP_DIR_NAME, opts.subdir);

  if (!existsSync(svgDir)) {
    console.error(color.red(`ERROR: directory not found: ${svgDir}`));
    return 1;
  }
  if (!Number.isFinite(opts.scale) || opts.scale <= 0) {
    console.error(color.red(`ERROR: invalid --scale value`));
    return 1;
  }

  console.log(color.cyan(`Target : ${svgDir}${opts.all ? ' (--all, recursive)' : ''}`));
  console.log(color.cyan(`Scale  : ${opts.scale}%`));
  console.log(color.cyan(`Mode   : ${opts.apply ? 'APPLY' : 'DRY-RUN'}`));
  if (opts.apply) console.log(color.cyan(`Backup : ${opts.backup ? backupDir : 'disabled (--no-backup)'}`));
  console.log();

  if (opts.apply && opts.backup) await mkdir(backupDir, { recursive: true });

  let resized = 0;
  let warned = 0;

  for await (const filePath of walkFiles(svgDir, { ext: '.svg', skipDirs: [BACKUP_DIR_NAME] })) {
    const outcome = await resizeOne(filePath, svgDir, backupDir, opts);
    if (outcome === 'resized') resized++;
    else warned++;
  }

  console.log();
  console.log(color.cyan('===== Summary ====='));
  console.log(color.green(`  Resized : ${resized}`));
  console.log(warned ? color.yellow(`  Skipped : ${warned} (no viewBox / unparsable tag)`) : '  Skipped : 0');
  if (!opts.apply) console.log(color.yellow('\nDry-run only - pass --apply to write changes.'));

  return 0;
}

process.exitCode = await main();
