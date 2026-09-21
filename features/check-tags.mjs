// check-tags.mjs
//
// Static analysis tool for signals_railway_signals.yaml.
//
// Detects issues that would otherwise surface as opaque errors during
// the Docker build (signal_features.sql.js) or cause silent mismatches
// between features and the database schema.
//
// Usage:
//   npm install
//   npm run check-tags
//
// Requires Node.js 21+.

import fs from 'fs';
import yaml from 'yaml';

const YAML_FILE = 'signals_railway_signals.yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const countryOf = feature => feature.country ?? 'GLOBAL';
const featureId = feature => `${ countryOf(feature) }::${ feature.description }`;

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

// 4. Features sharing the same country + description.
const findDuplicatedFeatures = signals =>
  duplicatesOf(groupBy(signals.features, featureId)).map(([id, items]) => ({
    id,
    count: items.length,
  }));

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

// 6. Static icon paths used by two features of the same country.
//    Different countries may legitimately reuse the same path (e.g. "fr/none").
const findDuplicatedIconPaths = signals => {
  const ownersByPath = {};
  for (const feature of signals.features) {
    for (const path of collectStaticIconPaths(feature)) {
      (ownersByPath[path] ??= []).push(feature);
    }
  }

  return Object.entries(ownersByPath)
    .filter(([, owners]) => owners.length > 1)
    .filter(([, owners]) => new Set(owners.map(countryOf)).size === 1)
    .map(([path, owners]) => ({ path, owners }));
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const printSection = (title, lines) => {
  console.log(`\n === ${ title } ===`);
  if (lines.length === 0) {
    console.log('OK');
  } else {
    for (const line of lines) console.log(line);
  }
};

const report = signals => {
  printSection(
    '1. Tags used but not declared',
    findUndeclaredTags(signals).map(t => `  - { tag: '${t}', title: '...' }`),
  );

  printSection(
    '2. Tags declared more than once',
    findDuplicatedDeclarations(signals).map(({ tag, count }) => `  - ${ tag } (${ count } times)`),
  );

  printSection(
    '3. Duplicated features (country + description)',
    findDuplicatedFeatures(signals).map(({ id, count }) => `  - ${ id } (${ count } times)`),
  );

  printSection(
    '4. Duplicated tags within the same feature',
    findTagsRepeatedInFeature(signals).map(
      ({ feature, tag }) => `  - [${ countryOf(feature) }] ${ feature.description }: '${tag}' appears multiple times`,
    ),
  );

  printSection(
    '5. Duplicated static icon paths (same country)',
    findDuplicatedIconPaths(signals).flatMap(({ path, owners }) => [
      `  - ${ path }`,
      ...owners.map(o => `      ${ featureId(o) }`),
    ]),
  );

  printSection(
    '6. Tags declared but never used (informative)',
    findUnusedTags(signals).map(t => `  - ${ t }`),
  );
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const signals = yaml.parse(fs.readFileSync(YAML_FILE, 'utf8'));
report(signals);
