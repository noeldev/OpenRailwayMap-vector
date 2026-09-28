#!/usr/bin/env node
// optimize-svg.mjs
//
// Prepares SVG files for the SDF sprite generator by running two phases:
//
//   Phase 1 - Convert <text> / <tspan> elements to paths using Inkscape.
//             Required because the sprite generator cannot handle text.
//
//   Phase 2 - Optimize all SVGs with SVGO (library mode).
//             Reduces file size and cleans up markup.
//
// Files are backed up to symbols/fr/_backup/ on first modification and never
// overwritten, so the pristine originals are always preserved.
//
// Run from anywhere: the project root is derived from the script location.

import { spawn } from 'node:child_process';
import { mkdir, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { optimize } from 'svgo';

import {
  DEFAULT_SVG_ROOT,
  PROJECT_ROOT,
  color,
  walkFiles,
} from './lib/shared.mjs';

const BACKUP_DIR_NAME = '_backup';

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

async function runTextConversionBatch(files, inkscapePath, targetDir, backupDir) {
  let converted = 0;
  let failed = 0;
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
      failed++;
    }
  }
  return { converted, failed };
}

// ---------- Phase 2: SVGO (library mode) ----------

async function optimizeOne(filePath) {
  const source = await readFile(filePath, 'utf8');
  const result = optimize(source, { path: filePath, multipass: true });
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
  const targetDir = DEFAULT_SVG_ROOT;
  const backupDir = join(targetDir, BACKUP_DIR_NAME);

  if (!existsSync(targetDir)) {
    console.error(color.red(`ERROR: target directory not found: ${targetDir}`));
    return 1;
  }

  console.log(color.cyan(`Project root  : ${PROJECT_ROOT}`));
  console.log(color.cyan(`Target folder : ${targetDir}`));
  console.log();

  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true });
    console.log(color.cyan(`Created backup directory: ${backupDir}`));
  }

  // Collect the SVG list once; both phases use it.
  const allFiles = [];
  for await (const f of walkFiles(targetDir, { ext: '.svg', skipDirs: [BACKUP_DIR_NAME] })) {
    allFiles.push(f);
  }

  let textResult = { converted: 0, failed: 0 };
  let svgoResult = { optimized: 0, failed: 0, savedBytes: 0 };

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
    const textFiles = [];
    for (const f of allFiles) {
      if (await hasNonEmptyText(f)) textFiles.push(f);
    }
    if (textFiles.length === 0) {
      console.log(color.green('  No SVG files with non-empty text elements found.'));
    } else {
      console.log(color.cyan(`  Found ${textFiles.length} file(s) to convert.`));
      textResult = await runTextConversionBatch(textFiles, inkscapePath, targetDir, backupDir);
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