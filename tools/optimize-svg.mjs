#!/usr/bin/env node
// optimize-svg.mjs
//
// Prepares SVG files for the SDF sprite generator by running three phases:
//
//   Phase 0 - Tidy pass (see ./lib/svg-tidy.mjs), run before text-to-path so
//             dead text/tspan attributes and styles are gone before Inkscape
//             bakes them onto the resulting <path> (SVGO's convertStyleToAttrs
//             would otherwise promote that dead CSS onto real attributes
//             instead of removing it).
//
//   Phase 1 - Convert <text> / <tspan> elements to paths using Inkscape.
//             Required because the sprite generator cannot handle text.
//             Inkscape crashes occasionally, so this phase retries only the
//             files still containing text, up to MAX_TEXT_PASSES times.
//
//   Phase 2 - Optimize all SVGs with SVGO (library mode).
//             Reduces file size and cleans up markup, including flattening
//             any leftover transform attributes onto the path data (see the
//             svgoPlugins() comment below).
//
// Files are backed up to tools/_backup/ on first modification and never
// overwritten, so the pristine originals are always preserved. The backup
// directory lives under tools/, not under symbols/fr/, so it never gets
// walked as part of the SVG tree and never interferes with a rebuild of that
// tree; see .gitignore in this folder.
//
// Run from anywhere: the project root is derived from the script location.
//
// Usage:
//   node tools/optimize-svg.mjs --subdir signals   # one family, recursively
//   node tools/optimize-svg.mjs --all              # the whole symbols/fr tree
//
// One of --subdir or --all is required: the tool rewrites files in place,
// so it never runs on a default target. Backups follow the same layout as
// resize-svg.mjs: tools/_backup/<subdir>/ for a --subdir run, plain
// tools/_backup/ (mirroring the full symbols/fr layout) for --all.

import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

import {
  DEFAULT_SVG_ROOT,
  PROJECT_ROOT,
  TOOLS_DIR,
  color,
  walkFiles,
} from './lib/shared.mjs';
import { tidySvgDocument } from './lib/svg-tidy.mjs';

const BACKUP_DIR_NAME = '_backup';

const HELP = `
Usage: node tools/optimize-svg.mjs (--subdir <name> | --all)

Options:
  --subdir <name>    Subfolder under symbols/fr to process, recursively
  --all              Process the whole symbols/fr tree
  -h, --help         Show this help

One of --subdir or --all is required: files are rewritten in place.
`;

function parseArgs(argv) {
  const opts = { subdir: null, all: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--subdir') opts.subdir = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.all && opts.subdir) throw new Error('--all and --subdir are mutually exclusive');
  if (!opts.help && !opts.all && !opts.subdir) throw new Error('one of --subdir <name> or --all is required');
  return opts;
}

// Safety cap on Phase 1 retry passes: Inkscape's crashes are transient, but a
// file that still has text after this many attempts is failing for a real
// reason and further retries would just waste time.
const MAX_TEXT_PASSES = 5;

// ---------- executable discovery (Inkscape only) ----------

async function findInkscape() {
  // Windows: standard install paths first.
  const candidates = [];
  for (const env of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[env];
    if (root) candidates.push(join(root, 'Inkscape', 'bin', 'inkscape.exe'));
  }
  for (const c of candidates) if (existsSync(c)) return c;

  // Fallback: PATH lookup (Linux, macOS, or a Windows install on PATH).
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolvePromise) => {
    const child = spawn(finder, ['inkscape'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return resolvePromise(null);
      const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      resolvePromise(first || null);
    });
    child.on('error', () => resolvePromise(null));
  });
}

// ---------- process helpers ----------

function runAndCapture(exe, args) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.on('error', (err) => resolvePromise({ code: -1, stdout, stderr: err.message }));
  });
}

// ---------- SVG helpers ----------

async function hasNonEmptyText(filePath) {
  const src = await readFile(filePath, 'utf8');
  const re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const inner = m[1].replace(/<[^>]+>/g, '');
    if (/\S/.test(inner)) return true;
  }
  return false;
}

// ---------- backup ----------

async function backupFile(filePath, rootDir, backupDir) {
  const relPath = relative(rootDir, filePath);
  const backupPath = join(backupDir, relPath);
  await mkdir(dirname(backupPath), { recursive: true });
  if (!existsSync(backupPath)) {
    await copyFile(filePath, backupPath);
  }
  return backupPath;
}

// ---------- Phase 0: tidy pass ----------

async function tidyOne(filePath) {
  const original = await readFile(filePath, 'utf8');
  const doc = new DOMParser().parseFromString(original, 'text/xml');
  tidySvgDocument(doc.documentElement);
  const cleaned = new XMLSerializer().serializeToString(doc.documentElement);

  // Keep whichever line ending the source file already used.
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const content = `<?xml version="1.0" encoding="UTF-8"?>${eol}${cleaned}${eol}`;
  if (content === original) return false;
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function runTidyBatch(files, targetDir, backupDir) {
  let tidied = 0;
  for (const file of files) {
    await backupFile(file, targetDir, backupDir);
    if (await tidyOne(file)) tidied++;
  }
  return { tidied };
}

// ---------- Phase 1: text to paths ----------

async function convertTextToPaths(inkscapePath, filePath) {
  const actions = `select-all;object-to-path;export-filename:${filePath};export-plain-svg;export-do`;
  const { code, stdout, stderr } = await runAndCapture(inkscapePath, [filePath, `--actions=${actions}`]);

  if (code !== 0) {
    console.log(color.red(`  FAILED (exit ${code}): ${(stdout + stderr).trim()}`));
    return false;
  }
  if (!existsSync(filePath)) {
    console.log(color.red('  FAILED: output file was not created'));
    return false;
  }
  if (await hasNonEmptyText(filePath)) {
    console.log(color.magenta('  WARN: file still contains non-empty text elements'));
    return false;
  }
  return true;
}

// Runs one pass over `files`. Returns which ones converted and which are
// still failing (restored to their original, still-text-bearing state), so
// the caller can decide whether another pass is worth attempting.
async function runTextConversionBatch(files, inkscapePath, targetDir, backupDir) {
  let converted = 0;
  const failedFiles = [];
  const total = files.length;
  let index = 0;

  for (const file of files) {
    index++;
    console.log(color.yellow(`  [${index}/${total}] ${relative(targetDir, file).split(sep).join('/')}`));
    const backupPath = await backupFile(file, targetDir, backupDir);

    if (await convertTextToPaths(inkscapePath, file)) {
      converted++;
    } else {
      await copyFile(backupPath, file);
      console.log(color.yellow('    Restored original'));
      failedFiles.push(file);
    }
  }
  return { converted, failedFiles };
}

// Repeats text-to-path conversion on whatever still needs it, since
// Inkscape's failures are typically transient crashes rather than files it
// will never manage to convert. Stops as soon as a pass makes no progress at
// all, rather than burning through every remaining pass on the same files.
async function runTextConversionUntilStable(files, inkscapePath, targetDir, backupDir) {
  let remaining = files;
  let converted = 0;
  let pass = 0;

  while (remaining.length > 0 && pass < MAX_TEXT_PASSES) {
    pass++;
    console.log(color.cyan(`  Pass ${pass}/${MAX_TEXT_PASSES}: converting ${remaining.length} file(s)...`));
    const result = await runTextConversionBatch(remaining, inkscapePath, targetDir, backupDir);
    converted += result.converted;

    if (result.failedFiles.length === remaining.length) {
      console.log(color.red(`  No progress in pass ${pass}; stopping retries.`));
      remaining = result.failedFiles;
      break;
    }
    remaining = result.failedFiles;
  }

  if (remaining.length > 0) {
    console.log(color.red(`  Still failing after ${pass} pass(es):`));
    for (const f of remaining) console.log(color.red(`    ${relative(targetDir, f).split(sep).join('/')}`));
  }

  return { converted, failed: remaining.length };
}

// ---------- Phase 2: SVGO (library mode) ----------

// preset-default already runs convertPathData, which applies any transform
// on a <path> to its own "d" data (removing the transform attribute) - but
// only when the element carries no "style" attribute and no "id". Inkscape's
// text-to-path output puts its fill/stroke in a "style" attribute, which
// silently blocks that step. convertStyleToAttrs moves those declarations
// onto plain presentation attributes first, so transforms left behind by
// Phase 1 (or by generate-aspects.mjs's inherited-transform wrapping) are
// actually flattened away instead of lingering in the optimized output.
function svgoPlugins() {
  return ['convertStyleToAttrs', 'preset-default'];
}

async function optimizeOne(filePath) {
  const source = await readFile(filePath, 'utf8');
  const result = optimize(source, { path: filePath, multipass: true, plugins: svgoPlugins() });
  if (typeof result.data !== 'string' || !result.data) return false;
  await writeFile(filePath, result.data, 'utf8');
  return true;
}

async function runSvgoBatch(files, targetDir, backupDir) {
  let optimized = 0;
  let failed = 0;
  let savedBytes = 0;
  const total = files.length;
  let index = 0;

  for (const file of files) {
    index++;
    const sizeBefore = (await stat(file)).size;
    const backupPath = await backupFile(file, targetDir, backupDir);
    const rel = relative(targetDir, file).split(sep).join('/');

    if (await optimizeOne(file)) {
      const sizeAfter = (await stat(file)).size;
      const delta = sizeBefore - sizeAfter;
      savedBytes += delta;
      const percent = sizeBefore > 0 ? Math.round((delta * 1000) / sizeBefore) / 10 : 0;
      console.log(color.green(
        `  [${index}/${total}] ${rel} (${sizeBefore} -> ${sizeAfter} bytes, -${percent}%)`
      ));
      optimized++;
    } else {
      await copyFile(backupPath, file);
      console.log(color.yellow(`  [${index}/${total}] ${rel} (restored original)`));
      failed++;
    }
  }
  return { optimized, failed, savedBytes };
}

// ---------- main ----------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(color.red(`ERROR: ${err.message}`));
    console.log(HELP);
    return 1;
  }
  if (opts.help) { console.log(HELP); return 0; }

  const targetDir = opts.all ? DEFAULT_SVG_ROOT : join(DEFAULT_SVG_ROOT, opts.subdir);
  const backupDir = opts.all ? join(TOOLS_DIR, BACKUP_DIR_NAME) : join(TOOLS_DIR, BACKUP_DIR_NAME, opts.subdir);

  if (!existsSync(targetDir)) {
    console.error(color.red(`ERROR: target directory not found: ${targetDir}`));
    return 1;
  }

  console.log(color.cyan(`Project root  : ${PROJECT_ROOT}`));
  console.log(color.cyan(`Target folder : ${targetDir}${opts.all ? ' (--all, recursive)' : ''}`));
  console.log();

  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true });
    console.log(color.cyan(`Created backup directory: ${backupDir}`));
  }

  // Collect the SVG list once; both phases use it. skipDirs guards against a
  // stray _backup/ left over under symbols/fr by an older version of this
  // script, back when the backup directory lived inside the SVG tree.
  const allFiles = [];
  for await (const f of walkFiles(targetDir, { ext: '.svg', skipDirs: [BACKUP_DIR_NAME] })) {
    allFiles.push(f);
  }

  let tidyResult = { tidied: 0 };
  let textResult = { converted: 0, failed: 0 };
  let svgoResult = { optimized: 0, failed: 0, savedBytes: 0 };

  // --- Phase 0 ---
  console.log();
  console.log(color.cyan('Phase 0: Tidy pass'));
  if (allFiles.length === 0) {
    console.log(color.green('  No SVG files found.'));
  } else {
    tidyResult = await runTidyBatch(allFiles, targetDir, backupDir);
    console.log(color.green(`  Tidied: ${tidyResult.tidied} / ${allFiles.length}`));
  }

  // --- Phase 1 ---
  console.log();
  console.log(color.cyan('Phase 1: Text to paths'));
  const inkscapePath = await findInkscape();

  if (!inkscapePath) {
    console.log(color.yellow('Inkscape not found: skipping text-to-path conversion.'));
    console.log(color.yellow('  Expected: %ProgramFiles%\\Inkscape\\bin\\inkscape.exe (Windows)'));
    console.log(color.yellow('  Install : winget install --id Inkscape.Inkscape -e --force'));
  } else {
    console.log(color.cyan(`  Inkscape: ${inkscapePath}`));
    // Pre-check: only files that actually still have text are ever handed to
    // Inkscape, which is slow and not worth invoking on files already done.
    const textFiles = [];
    for (const f of allFiles) {
      if (await hasNonEmptyText(f)) textFiles.push(f);
    }
    if (textFiles.length === 0) {
      console.log(color.green('  No SVG files with non-empty text elements found.'));
    } else {
      console.log(color.cyan(`  Found ${textFiles.length} file(s) to convert.`));
      textResult = await runTextConversionUntilStable(textFiles, inkscapePath, targetDir, backupDir);
    }
  }

  // --- Phase 2 ---
  console.log();
  console.log(color.cyan('Phase 2: SVGO optimization'));
  if (allFiles.length === 0) {
    console.log(color.green('  No SVG files found.'));
  } else {
    console.log(color.cyan(`  Found ${allFiles.length} file(s) to optimize.`));
    svgoResult = await runSvgoBatch(allFiles, targetDir, backupDir);
  }

  // --- Summary ---
  console.log();
  console.log(color.cyan('===== Summary ====='));
  console.log();
  console.log(color.cyan('Phase 0 - Tidy pass:'));
  console.log(color.green(`  Tidied : ${tidyResult.tidied}`));
  console.log();
  console.log(color.cyan('Phase 1 - Text to paths:'));
  console.log(color.green(`  Converted : ${textResult.converted}`));
  console.log(textResult.failed
    ? color.red(`  Failed    : ${textResult.failed}`)
    : color.green('  Failed    : 0'));
  console.log();
  console.log(color.cyan('Phase 2 - SVGO optimization:'));
  console.log(color.green(`  Optimized  : ${svgoResult.optimized}`));
  console.log(svgoResult.failed
    ? color.red(`  Failed     : ${svgoResult.failed}`)
    : color.green('  Failed     : 0'));
  console.log(color.cyan(`  Total saved: ${Math.round(svgoResult.savedBytes / 1024 * 10) / 10} KB`));
  console.log();
  console.log(color.cyan(`Backups: ${backupDir}`));
  console.log();
  console.log(color.cyan('Next steps:'));
  console.log('  cd ../..');
  console.log('  docker compose up -d --build martin');
  console.log('  docker compose stop proxy; docker compose rm -f proxy; docker compose up -d proxy');

  return 0;
}

process.exit(await main());
