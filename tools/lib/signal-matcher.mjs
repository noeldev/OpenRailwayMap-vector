// signal-matcher.mjs
// Resolves the signal features of one OSM node the way the ORM import does
// (import/sql/signal_features.sql.mjs): per signal type, the first matching
// feature of the YAML wins, a feature is only drawn for its own (first)
// type, and all features of the node form one pile ordered by rank (their
// position in the YAML), lowest rank at the bottom. The map shows the first
// MAX_FEATURES of the pile, filtered by the selected categories.

import fs from 'node:fs';
import yaml from 'yaml';

/** Features drawn by the map per node (feature0 to feature11). */
export const MAX_FEATURES = 12;

/** Loads the signal YAML: types, tag value types and features. */
export function loadSignalConfig(yamlPath) {
  const config = yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
  const types = config.types;
  // Like the import: the signal type of a feature is the first type (in
  // types order) whose tag the feature carries.
  const signalTypeOf = (feature) => types.find(({ type }) => feature.tags.some((tag) => tag.tag === `railway:signal:${type}`))?.type;
  return {
    types,
    categories: [...new Set(types.map((type) => type.category))],
    tagTypes: Object.fromEntries(config.tags.map((tag) => [tag.tag, tag.type])),
    features: config.features.map((feature, rank) => ({ ...feature, rank, signalType: signalTypeOf(feature) })),
  };
}

const TRUE_VALUES = ['yes', 'true', '1'];

// Typed view of one OSM tag: an array for array tags, a boolean for boolean
// tags, the raw string otherwise; undefined when the tag is absent.
function tagValue(config, tags, key) {
  const raw = tags[key];
  if (raw === undefined) return undefined;
  switch (config.tagTypes[key]) {
    case 'array': return raw.split(';').map((v) => v.trim());
    case 'boolean': return TRUE_VALUES.includes(raw);
    default: return raw;
  }
}

function matchesValue(value, expected) {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

function matchesAny(value, expected) {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (!expected) return true;
  return Array.isArray(value) ? value.some((v) => expected.includes(v)) : expected.includes(value);
}

function matchesAll(value, expected) {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  return Array.isArray(value) && expected.every((v) => value.includes(v));
}

// Exact set of values (array tags only).
function matchesValues(value, expected) {
  return Array.isArray(value) && matchesAll(value, expected) && value.every((v) => expected.includes(v));
}

// Returns the text substituted for "{}", or null when nothing matches. Like
// the import SQL (regexp_substr): for a plain tag, the first capture group
// (or the whole match when the regex has none); for an array tag, the whole
// match of the longest matching item.
function regexCapture(value, regex) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? '' : null;
  const re = new RegExp(regex);
  if (!Array.isArray(value)) {
    const m = value.match(re);
    return m ? (m[1] ?? m[0]) : null;
  }
  const candidates = value.map((v) => v.match(re)).filter(Boolean).map((m) => m[0]);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0))[0];
}

function matchesFeatureTags(config, tags, feature) {
  return feature.tags.every((tag) => {
    const value = tagValue(config, tags, tag.tag);
    if (tag.value !== undefined) return matchesValue(value, tag.value);
    if (tag.all) return matchesAll(value, tag.all);
    if (tag.values) return matchesValues(value, tag.values);
    return matchesAny(value, tag.any);
  });
}

// Evaluates one icon entry: { id, position } or null.
function resolveIcon(config, tags, icon) {
  const position = icon.position ?? 'center';
  if (!icon.match) return icon.default ? { id: icon.default, position } : null;

  const value = tagValue(config, tags, icon.match);
  for (const iconCase of icon.cases ?? []) {
    if (iconCase.regex) {
      const capture = regexCapture(value, iconCase.regex);
      if (capture !== null) return { id: iconCase.value.replace('{}', `{${capture}}`), position };
    } else if (iconCase.all ? matchesAll(value, iconCase.all)
      : iconCase.any ? matchesAny(value, iconCase.any)
        : matchesValue(value, iconCase.exact)) {
      return { id: iconCase.value, position };
    }
  }
  return icon.default ? { id: icon.default, position } : null;
}

// A fallback section only checks tags the winning section checks too (e.g.
// the reporting plate without arrow behind the one with arrow): it can never
// be the one a node needs, so it is not worth a warning.
const conditionKey = (tag) => JSON.stringify(tag, Object.keys(tag).sort());
function isFallback(feature, winner) {
  const winnerConditions = new Set(winner.tags.map(conditionKey));
  return feature.tags.every((tag) => winnerConditions.has(conditionKey(tag)));
}

const unknownEntry = (type, category) => ({
  type, category, description: `Unknown signal (${type})`, rank: null,
  icons: [{ id: `general/signal-unknown-${type}`, position: 'center' }],
});

/**
 * Resolves every signal feature of a node.
 * @returns {Array<{type: string, category: string, description: string, rank: number|null,
 *   deactivated: boolean, icons: Array<{id: string, position: string}>,
 *   shadowed?: Array<{description: string, fallback: boolean}>}>}
 *   The pile of the node, bottom first (rank order, unknown signals last).
 */
export function matchSignals(config, tags) {
  const pile = [];
  for (const { type, category } of config.types) {
    const key = `railway:signal:${type}`;
    if (tags[key] === undefined) continue;

    const matching = config.features.filter((f) => f.tags.some((t) => t.tag === key) && matchesFeatureTags(config, tags, f));
    const feature = matching[0];
    let entry;
    if (!feature) {
      entry = unknownEntry(type, category);
    } else if (feature.signalType === type) {
      const icons = feature.icon.map((icon) => resolveIcon(config, tags, icon)).filter(Boolean);
      // Later matching features of the same type are never drawn.
      const shadowed = matching.slice(1).filter((f) => f.signalType === type)
        .map((f) => ({ description: f.description, fallback: isFallback(f, feature) }));
      entry = { type, category, description: feature.description, rank: feature.rank, icons, shadowed };
    } else {
      // Drawn by the column of its own type.
      continue;
    }
    entry.deactivated = TRUE_VALUES.includes(tags[`${key}:deactivated`]);
    pile.push(entry);
  }

  if (pile.length === 0 && tags.railway === 'signal') {
    pile.push({ ...unknownEntry(null, 'other'), description: 'Unknown signal', icons: [{ id: 'general/signal-unknown', position: 'center' }], deactivated: false });
  }
  return pile.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}
