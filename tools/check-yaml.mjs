#!/usr/bin/env node
// check-yaml.mjs
// Static analysis of signals_railway_signals.yaml.
//
// Sections 1-4 are correctness checks: every line they print is worth a
// look. Sections 5-6 are cross-reference listings that are "informative"
// even when nothing is wrong - a small accessory icon (a plate, a caisson
// shape) is legitimately reused by dozens of unrelated features, and the
// tag list legitimately declares more of the OSM railway:signal:* schema
// than this file's features currently exercise. Printed in full by
// default, those two sections used to bury the four checks that actually
// matter under hundreds of expected, unactionable lines - so by default
// they only print a count; pass --verbose to see the full listing.

import fs from 'fs';
import yaml from 'yaml';
import { resolve } from 'node:path';

import { DEFAULT_YAML_FILE, color } from './lib/shared.mjs';

const HELP = `
Usage: node tools/check-yaml.mjs [file] [options]

  file          YAML file to check (default: ${DEFAULT_YAML_FILE})

Options:
  --verbose, -v  Also list sections 5 and 6 in full (shared icon paths,
                 unused tag declarations) instead of just their count
  -h, --help     Show this help
`;

function parseArgs(argv) {
  const opts = { file: null, verbose: false, help: false };
  for (const a of argv) {
    if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (!opts.file) opts.file = a;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const countryOf = feature => feature.country ?? 'GLOBAL';
const featureId = feature => `${countryOf(feature)}::${feature.description}`;

// A feature's full tag signature (tag + value, order-independent). Two
// features only count as true duplicates when this matches too - sharing a
// description alone is normal (e.g. the same label used for a sign and its
// board variant).
const tagSignature = feature =>
  JSON.stringify((feature.tags ?? []).map(t => [t.tag, t.value ?? null]).sort());

const groupBy = (items, keyFn) =>
  items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ??= []).push(item);
    return acc;
  }, {});

const duplicatesOf = groups =>
  Object.entries(groups).filter(([, items]) => items.length > 1);

const uniqueSorted = values => [...new Set(values)].sort();

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

// Tags referenced anywhere in the file: feature tags and icon match keys.
const collectUsedTags = signals => {
  const tags = [];
  for (const feature of signals.features) {
    for (const t of feature.tags ?? []) tags.push(t.tag);
    for (const icon of feature.icon ?? []) {
      if (icon.match) tags.push(icon.match);
    }
  }
  return uniqueSorted(tags);
};

// Static icon paths referenced by a feature. Dynamic paths containing
// "{}" are excluded: they are templates, not concrete files.
const collectStaticIconPaths = feature => {
  const paths = new Set();
  for (const icon of feature.icon ?? []) {
    if (icon.default) paths.add(icon.default);
    for (const c of icon.cases ?? []) {
      if (c.value && !c.value.includes('{}')) paths.add(c.value);
    }
  }
  return [...paths];
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// 1. Tags referenced in features but absent from the top-level list.
const findUndeclaredTags = signals => {
  const declared = new Set(signals.tags.map(t => t.tag));
  return collectUsedTags(signals).filter(t => !declared.has(t));
};

// 2. Declared tags never referenced anywhere.
const findUnusedTags = signals => {
  const used = new Set(collectUsedTags(signals));
  return signals.tags.map(t => t.tag).filter(t => !used.has(t)).sort();
};

// 3. Tags declared more than once at the top level.
const findDuplicatedDeclarations = signals =>
  duplicatesOf(groupBy(signals.tags, t => t.tag)).map(([tag, items]) => ({
    tag,
    count: items.length,
  }));

// 4. Features that are true duplicates: same country + description AND the
//    exact same tag set. (Sharing just the description is routine - sign
//    and board variants of the same plate are named identically on purpose.)
const findDuplicatedFeatures = signals => {
  const byId = groupBy(signals.features, featureId);
  const issues = [];
  for (const [id, items] of Object.entries(byId)) {
    if (items.length < 2) continue;
    for (const [, sameSignature] of duplicatesOf(groupBy(items, tagSignature))) {
      issues.push({ id, count: sameSignature.length });
    }
  }
  return issues;
};

// 5. Tags repeated within a single feature.
const findTagsRepeatedInFeature = signals => {
  const issues = [];
  for (const feature of signals.features) {
    const seen = new Set();
    for (const t of feature.tags ?? []) {
      if (seen.has(t.tag)) {
        issues.push({ feature, tag: t.tag });
      }
      seen.add(t.tag);
    }
  }
  return issues;
};

// 6. Static icon paths used by two or more features of the same country.
//    Informative, not an error: a shared accessory icon (a plate, a
//    caisson shape) is meant to be reused by many unrelated features.
//    Each feature counts once per path even if it references it from
//    several icon layers.
const findSharedIconPaths = signals => {
  const ownersByPath = {};
  for (const feature of signals.features) {
    for (const path of collectStaticIconPaths(feature)) {
      ((ownersByPath[path] ??= new Map()).set(featureId(feature), feature));
    }
  }

  return Object.entries(ownersByPath)
    .map(([path, ownerMap]) => ({ path, owners: [...ownerMap.values()] }))
    .filter(({ owners }) => owners.length > 1)
    .filter(({ owners }) => new Set(owners.map(countryOf)).size === 1);
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const printSection = (title, lines) => {
  console.log(`\n === ${title} ===`);
  if (lines.length === 0) {
    console.log('OK');
  } else {
    for (const line of lines) console.log(line);
  }
};

// For sections 5-6: just the count by default, full detail with --verbose.
const printInformativeSection = (title, items, toLines, note, verbose) => {
  console.log(`\n === ${title} ===`);
  if (items.length === 0) {
    console.log('OK');
  } else if (verbose) {
    for (const line of toLines(items)) console.log(line);
  } else {
    console.log(color.cyan(`${items.length} item(s) - ${note}`));
    console.log(color.cyan('  Run with --verbose to list them.'));
  }
};

const report = (signals, opts) => {
  printSection(
    '1. Tags used but not declared',
    findUndeclaredTags(signals).map(t => `  - { tag: '${t}', title: '...' }`),
  );

  printSection(
    '2. Tags declared more than once',
    findDuplicatedDeclarations(signals).map(({ tag, count }) => `  - ${tag} (${count} times)`),
  );

  printSection(
    '3. Duplicated features (same country, description AND tags)',
    findDuplicatedFeatures(signals).map(({ id, count }) => `  - ${id} (${count} times)`),
  );

  printSection(
    '4. Duplicated tags within the same feature',
    findTagsRepeatedInFeature(signals).map(
      ({ feature, tag }) => `  - [${countryOf(feature)}] ${feature.description}: '${tag}' appears multiple times`,
    ),
  );

  printInformativeSection(
    '5. Static icon paths shared by several features (same country)',
    findSharedIconPaths(signals),
    items => items.flatMap(({ path, owners }) => [
      `  - ${path}`,
      ...owners.map(o => `      ${featureId(o)}`),
    ]),
    'normal for shared accessory icons (plates, caisson shapes, etc.)',
    opts.verbose,
  );

  printInformativeSection(
    '6. Tags declared but never used',
    findUnusedTags(signals),
    items => items.map(t => `  - ${t}`),
    'often legitimate: declares more of the OSM schema than this file currently uses',
    opts.verbose,
  );
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }

  const yamlFile = opts.file ? resolve(opts.file) : DEFAULT_YAML_FILE;
  if (!fs.existsSync(yamlFile)) {
    console.error(color.red(`ERROR: YAML file not found: ${yamlFile}`));
    return 1;
  }

  const signals = yaml.parse(fs.readFileSync(yamlFile, 'utf8'));
  report(signals, opts);
  return 0;
}

process.exitCode = await main();
