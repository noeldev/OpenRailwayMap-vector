#!/usr/bin/env node
// audit-svg.mjs
// Generate an audit of all SVG icons under a directory.
//
// Usage:
//   node tools/audit-svg.mjs                        # HTML report (default)
//   node tools/audit-svg.mjs --format text          # plain text table on stdout
//   node tools/audit-svg.mjs --format json          # machine-readable
//   node tools/audit-svg.mjs --root symbols/fr/boxes --min 100
//   node tools/audit-svg.mjs --out report.html
//
// The report shows, for each icon: a square-aligned preview, its relative
// path, viewBox size, file size, and warning markers.
//
// The HTML/CSS/JS template lives in lib/audit-template.{html,css,js}
// and is loaded and assembled by lib/audit-template.mjs.

import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import {
  DEFAULT_MIN_VIEWBOX_DIM,
  DEFAULT_SVG_ROOT,
  TOOLS_DIR,
  color,
  escHtml as esc,
  hasInkscapeMarkup,
  hasNonEmptyText,
  humanBytes,
  parseSvgOpenTag,
  parseViewBox,
  toPosix,
  walkFiles,
} from './lib/shared.mjs';
import { renderAuditHtml } from './lib/audit-template.mjs';

const HELP = `
SVG icon audit

Usage:
  node tools/audit-svg.mjs [options]

Options:
  --root <dir>     Directory to scan (default: <project>/symbols/fr)
  --min  <n>       Minimum viewBox dimension (default: ${DEFAULT_MIN_VIEWBOX_DIM})
  --format <fmt>   html | text | json (default: html)
  --out  <file>    Output file for --format html (default: <tools>/audit-svg.html)
  -h, --help       Show this help

Examples:
  node tools/audit-svg.mjs
  node tools/audit-svg.mjs --root symbols/fr/boxes --format text
  node tools/audit-svg.mjs --format json > icons.json
`;

// ---------- helpers shared by the renderers ----------

const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
const vbLabelOf = (vb) => vb ? `${fmt(vb.w)} × ${fmt(vb.h)}` : 'missing';

// ---------- argument parsing ----------

function parseArgs(argv) {
  const opts = {
    root: DEFAULT_SVG_ROOT,
    min: DEFAULT_MIN_VIEWBOX_DIM,
    format: 'html',
    out: join(TOOLS_DIR, 'audit-svg.html'),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = resolve(argv[++i]);
    else if (a === '--min') opts.min = Number(argv[++i]);
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '-h' || a === '--help') return { help: true };
    else return { error: `Unknown option: ${a}` };
  }

  if (!['html', 'text', 'json'].includes(opts.format)) {
    return { error: `Unknown format: ${opts.format} (expected html, text or json)` };
  }
  return { opts };
}

// ---------- scan ----------

async function scanIcons(absRoot, minDim) {
  const baseDir = dirname(absRoot);
  const icons = [];

  for await (const file of walkFiles(absRoot, { ext: '.svg' })) {
    const [source, fileStat] = await Promise.all([
      readFile(file, 'utf8'),
      stat(file),
    ]);
    const attrs = parseSvgOpenTag(source);

    const explicitViewBox = parseViewBox(attrs.viewBox);
    const w = parseFloat(attrs.width);
    const h = parseFloat(attrs.height);
    const derivedViewBox = !explicitViewBox && Number.isFinite(w) && Number.isFinite(h)
      ? { x: 0, y: 0, w, h }
      : null;
    const viewBox = explicitViewBox || derivedViewBox;

    const rel = toPosix(relative(baseDir, file));
    const hasText = hasNonEmptyText(source);
    const inkscape = hasInkscapeMarkup(source);

    const flags = [];
    if (!viewBox) {
      flags.push('missing viewBox');
    } else {
      if (viewBox.w < minDim) flags.push(`width < ${minDim}`);
      if (viewBox.h < minDim) flags.push(`height < ${minDim}`);
      if (!explicitViewBox && derivedViewBox) flags.push('derived from width/height (no viewBox)');
    }
    if (hasText) flags.push('contains text (needs Inkscape)');

    icons.push({
      rel,
      source,
      viewBox,
      width: Number.isFinite(w) ? w : null,
      height: Number.isFinite(h) ? h : null,
      sizeBytes: fileStat.size,
      hasText,
      inkscape,
      minDim: viewBox ? Math.min(viewBox.w, viewBox.h) : null,
      warn: flags.length > 0,
      flags,
    });
  }

  icons.sort((a, b) => a.rel.localeCompare(b.rel, 'en'));
  return { icons, baseDir };
}

// ---------- text output ----------

function renderText(icons, total, warnCount) {
  if (total === 0) {
    console.log('(no SVG files found)');
    return;
  }
  const nameW = Math.min(60, Math.max(...icons.map((i) => i.rel.length)));
  const vbW = 16;
  const sizeW = 9;

  for (const icon of icons) {
    const name = icon.rel.padEnd(nameW);
    const vb = vbLabelOf(icon.viewBox).padEnd(vbW);
    const size = humanBytes(icon.sizeBytes).padStart(sizeW);
    const mark = icon.warn ? '⚠' : '✓';
    const extra = [];
    if (icon.hasText) extra.push('TEXT');
    if (icon.inkscape) extra.push('INKSCAPE');
    const suffix = extra.length ? '  [' + extra.join(' ') + ']' : '';
    console.log(`${name}  viewBox=${vb}  ${size}  ${mark}${suffix}`);
  }
  console.log('');
  console.log(`Total: ${total} icon${total === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'}.`);
}

// ---------- JSON output ----------

function renderJson(icons, total, warnCount, absRoot, minDim) {
  const payload = {
    root: toPosix(absRoot),
    minViewBox: minDim,
    total,
    warnCount,
    icons: icons.map((i) => ({
      path: i.rel,
      viewBox: i.viewBox,
      width: i.width,
      height: i.height,
      sizeBytes: i.sizeBytes,
      hasText: i.hasText,
      inkscape: i.inkscape,
      warn: i.warn,
      flags: i.flags,
    })),
  };
  console.log(JSON.stringify(payload, null, 2));
}

// ---------- HTML output ----------
//
// renderHtml() only builds the per-icon cards and the empty-state block,
// then hands everything to renderAuditHtml() from lib/audit-template.mjs.
// The HTML structure, CSS and client-side JS live in separate files.

function renderHtml(icons, total, warnCount, absRoot, displayRoot, minDim) {
  const cardsHtml = icons.map((icon) => {
    const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(icon.source);
    const vbLabel = vbLabelOf(icon.viewBox);
    const titleAttr = icon.flags.length ? ' title="' + esc(icon.flags.join(' • ')) + '"' : '';
    const minForSort = icon.minDim ?? -1;
    const badges = [];
    if (icon.hasText) badges.push('<span class="mini">TEXT</span>');
    if (icon.inkscape) badges.push('<span class="mini">INK</span>');

    return [
      `<article class="card${icon.warn ? ' warn' : ''}"`,
      `         data-path="${esc(icon.rel)}"`,
      `         data-min="${minForSort}"`,
      `         data-size="${icon.sizeBytes}"`,
      `         data-warn="${icon.warn ? 1 : 0}"${titleAttr}>`,
      `  <div class="thumb"><img loading="lazy" alt="" src="${dataUri}"></div>`,
      `  <span class="flag ${icon.warn ? 'warn' : 'ok'}" aria-hidden="true">${icon.warn ? '⚠' : '✓'}</span>`,
      `  <div class="body">`,
      `    <div class="path">${esc(icon.rel)}</div>`,
      `    <div class="meta">`,
      `      <span class="vb">viewBox ${esc(vbLabel)}</span>`,
      `      <span class="size">${humanBytes(icon.sizeBytes)}</span>`,
      `    </div>`,
      badges.length ? `    <div class="markers">${badges.join('')}</div>` : '',
      `  </div>`,
      `</article>`,
    ].filter(Boolean).join('\n');
  }).join('\n');

  const emptyStateHtml = total === 0 ? `
  <div class="empty">
    <p><strong>No SVG files found.</strong></p>
    <p>Scanned: <code>${esc(absRoot)}</code></p>
    <p>If this looks wrong, check <code>--root</code>.</p>
  </div>` : '';

  return renderAuditHtml({
    TITLE: esc(displayRoot),
    TOTAL: total,
    TOTAL_PLURAL: total === 1 ? '' : 's',
    MIN: minDim,
    WARN_COUNT: warnCount,
    EMPTY_STATE: emptyStateHtml,
    CARDS: cardsHtml,
  });
}

// ---------- main ----------

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (parsed.error) {
    console.error(`✗ ${parsed.error}`);
    return 1;
  }

  const { root, min, format, out } = parsed.opts;

  // Validate the scan root up front so an empty report never happens silently.
  const absRoot = resolve(root);
  let rootStat;
  try {
    rootStat = await stat(absRoot);
  } catch {
    console.error(`✗ Scan root does not exist: ${absRoot}`);
    console.error(`  Current working directory: ${process.cwd()}`);
    return 1;
  }
  if (!rootStat.isDirectory()) {
    console.error(`✗ Scan root is not a directory: ${absRoot}`);
    return 1;
  }

  const baseDir = dirname(absRoot);
  // Label shown in the report title: relative to the scan root's parent.
  const displayRoot = toPosix(relative(baseDir, absRoot));

  console.log(`Scanning: ${absRoot}`);
  console.log(`Relative to: ${baseDir}`);

  const { icons } = await scanIcons(absRoot, min);
  const total = icons.length;
  const warnCount = icons.filter((i) => i.warn).length;

  if (format === 'text') {
    renderText(icons, total, warnCount);
    return 0;
  }

  if (format === 'json') {
    renderJson(icons, total, warnCount, absRoot, min);
    return 0;
  }

  // format === 'html'
  const html = renderHtml(icons, total, warnCount, absRoot, displayRoot, min);
  await writeFile(out, html, 'utf8');
  console.log(color.green(
    `✓ Scanned ${total} icon${total === 1 ? '' : 's'}, ` +
    `${warnCount} warning${warnCount === 1 ? '' : 's'}.`
  ));
  console.log(`  → ${out}`);
  return 0;
}

// ---------- entry point ----------

// process.exitCode (not process.exit) lets Node flush stdout/stderr cleanly
// on Windows before the process terminates. Combined with spawnSync in
// cli.mjs, this eliminates the "silent run" symptom.
try {
  process.exitCode = await main();
} catch (err) {
  console.error('Unexpected error:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
