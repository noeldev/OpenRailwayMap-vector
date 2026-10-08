#!/usr/bin/env node
// render-node.mjs
// Renders the signals of OSM nodes, or of hand-written tag sets, as one SVG
// (or PNG) image, following the ORM feature matching and icon layout. The
// project YAML and symbols are read in place; the output embeds the icons
// it uses so it stays viewable on its own. Scenes (nodes or tag sets) are
// drawn side by side, each signal (feature) of a scene is its own <g>.
// Like the map, a node shows one pile of at most MAX_FEATURES features,
// filtered by the selected signal categories.
//
// Usage:
//   node tools/render-node.mjs <node id>... [options]
//   node tools/render-node.mjs --tags-file <file> [options]
//   node tools/render-node.mjs --tag <key=value>... [options]

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_ROOT, TOOLS_DIR, DEFAULT_YAML_FILE, color } from './lib/shared.mjs';
import { MAX_FEATURES, loadSignalConfig, matchSignals } from './lib/signal-matcher.mjs';
import { composeSvg } from './lib/icon-composer.mjs';
import { fetchNodeTags } from './lib/osm-api.mjs';

const DEFAULT_SYMBOLS = path.join(PROJECT_ROOT, 'symbols');
const DEFAULT_BACKGROUND = '#e0e0e0';
// Template fonts, so that icons still holding <text> render in a PNG.
const FONTS_DIR = path.join(TOOLS_DIR, 'aspects', 'fonts');

const HELP = `
Usage: node tools/render-node.mjs [<node id>...] [options]

Scenes (at least one source is required; scenes are drawn side by side):
  <node id>           OSM node whose tags are read from the OSM API
  --tags-file <file>  Tag sets read from a file: a JSON object of tags, an
                      array of { "name": ..., "tags": {...} }, an object of
                      name -> tags, or plain "key=value" lines (one set)
  --tag <key=value>   Tag added to (or overriding) every scene; alone, it
                      builds a single scene. Repeatable

Options:
  --category <names>  Comma-separated signal categories to show, like the map
                      filter (main, distant, speed, ...; default: all)
  --scale <n>         Display size multiplier of the map pixel size (default: 10)
  --background <c>    Background color, drawn with a soft shadow under each
                      signal, or "none" for transparent (default: ${DEFAULT_BACKGROUND})
  --png               Write a PNG instead of an SVG (also implied by --out *.png)
  --out <file>        Output file (default: the tags file name, or the first
                      scene name, with .svg|.png)
  --verbose           Also list the fallback sections that match but are not
                      used (a more general section behind the one drawn)
  --yaml <file>       Signal YAML (default: features/signals_railway_signals.yaml)
  --symbols <dir>     Icon tree (default: symbols)
  -h, --help          Show this help
`;

function parseTagAssignment(text) {
  const index = text.indexOf('=');
  if (index <= 0) throw new Error(`invalid tag "${text}" (expected key=value)`);
  return [text.slice(0, index).trim(), text.slice(index + 1).trim()];
}

function parseArgs(argv) {
  const opts = {
    nodeIds: [], tagsFiles: [], tags: {}, categories: null, scale: 10, background: DEFAULT_BACKGROUND,
    png: false, verbose: false, out: null, yaml: DEFAULT_YAML_FILE, symbols: DEFAULT_SYMBOLS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tags-file') opts.tagsFiles.push(argv[++i]);
    else if (a === '--tag') { const [k, v] = parseTagAssignment(argv[++i] ?? ''); opts.tags[k] = v; }
    else if (a === '--category') opts.categories = (argv[++i] ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    else if (a === '--scale') opts.scale = Number(argv[++i]);
    else if (a === '--background') { const c = argv[++i]; opts.background = c === 'none' ? null : c; }
    else if (a === '--png') opts.png = true;
    else if (a === '--verbose') opts.verbose = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--yaml') opts.yaml = argv[++i];
    else if (a === '--symbols') opts.symbols = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (/^\d+$/.test(a)) opts.nodeIds.push(a);
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.nodeIds.length === 0 && opts.tagsFiles.length === 0 && Object.keys(opts.tags).length === 0) {
    throw new Error('a node id, --tags-file or --tag is required');
  }
  if (!Number.isFinite(opts.scale) || opts.scale <= 0) throw new Error('invalid --scale value');
  if (opts.out && path.extname(opts.out).toLowerCase() === '.png') opts.png = true;
  return opts;
}

const isTagObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.values(value).every((v) => typeof v === 'string');

// Scenes of one tags file (see HELP for the accepted forms).
function readTagsFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const base = path.basename(file, path.extname(file));
  if (!/^\s*[[{]/.test(text)) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    return [{ name: base, tags: Object.fromEntries(lines.map(parseTagAssignment)) }];
  }
  const data = JSON.parse(text);
  if (Array.isArray(data)) return data.map((s, i) => ({ name: s.name ?? `${base}-${i + 1}`, tags: s.tags }));
  if (isTagObject(data)) return [{ name: base, tags: data }];
  return Object.entries(data).map(([name, tags]) => ({ name, tags }));
}

async function loadScenes(opts) {
  const scenes = [];
  for (const id of opts.nodeIds) scenes.push({ name: `node-${id}`, tags: await fetchNodeTags(id) });
  for (const file of opts.tagsFiles) scenes.push(...readTagsFile(file));
  if (scenes.length === 0) scenes.push({ name: 'tags', tags: {} });
  return scenes.map((scene) => ({ ...scene, tags: { ...scene.tags, ...opts.tags } }));
}

async function writePng(file, svg) {
  let Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch {
    throw new Error('PNG output needs @resvg/resvg-js (run npm install in tools/)');
  }
  const fontFiles = fs.existsSync(FONTS_DIR) ? fs.readdirSync(FONTS_DIR).map((f) => path.join(FONTS_DIR, f)) : [];
  fs.writeFileSync(file, new Resvg(svg, { font: { loadSystemFonts: true, fontFiles } }).render().asPng());
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(color.red(`ERROR: ${err.message}`));
    console.log(HELP);
    return 1;
  }

  const config = loadSignalConfig(opts.yaml);
  const unknown = (opts.categories ?? []).filter((c) => !config.categories.includes(c));
  if (unknown.length) {
    console.error(color.red(`ERROR: unknown categories: ${unknown.join(', ')} (known: ${config.categories.join(', ')})`));
    return 1;
  }
  const selected = (f) => !opts.categories || opts.categories.includes(f.category);

  const scenes = [];
  for (const { name, tags } of await loadScenes(opts)) {
    const pile = matchSignals(config, tags);
    console.log(color.cyan(`${name}:`));
    // Bottom first: the map draws the first MAX_FEATURES of the pile, then
    // hides the features of unselected categories.
    pile.forEach((f, index) => {
      const line = `  ${f.description} [${f.category}]${f.deactivated ? ' (deactivated)' : ''}: ${f.icons.map((i) => i.position === 'center' ? i.id : `${i.id}@${i.position}`).join(' | ')}`;
      if (index >= MAX_FEATURES) console.log(color.yellow(`${line}  [not shown: ${MAX_FEATURES} features per node]`));
      else if (!selected(f)) console.log(color.yellow(`${line}  [not shown: category filtered out]`));
      else console.log(line);
      for (const shadowed of f.shadowed ?? []) {
        if (!shadowed.fallback) {
          console.log(color.yellow(`  ${shadowed.description}  [not shown: same signal type (${f.type}) as ${f.description}]`));
        } else if (opts.verbose) {
          console.log(`  ${shadowed.description}  [fallback section, not used]`);
        }
      }
    });
    const features = pile.slice(0, MAX_FEATURES).filter(selected);
    if (features.length === 0) {
      console.log(color.yellow('  no signal feature, skipped'));
      continue;
    }
    scenes.push({ name, features });
  }
  if (scenes.length === 0) {
    console.error(color.yellow('Nothing to render.'));
    return 1;
  }

  // One tags file and nothing else: the image is named after the file.
  const single = opts.tagsFiles.length === 1 && opts.nodeIds.length === 0;
  const baseName = single ? path.basename(opts.tagsFiles[0], path.extname(opts.tagsFiles[0])) : scenes[0].name;
  const out = opts.out ?? `${baseName}.${opts.png ? 'png' : 'svg'}`;
  const svg = composeSvg(scenes, opts.symbols, {
    scale: opts.scale, title: scenes.map((s) => s.name).join(', '), background: opts.background, labels: scenes.length > 1,
  });
  try {
    if (opts.png) await writePng(out, svg);
    else fs.writeFileSync(out, svg, 'utf8');
  } catch (err) {
    console.error(color.red(`ERROR: ${err.message}`));
    return 1;
  }
  console.log(color.green(`Written: ${out}`));
  return 0;
}

process.exitCode = await main();
