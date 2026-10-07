// signal-matcher.mjs
// Resolves the signal features of one OSM node the way the ORM import does
// (import/sql/signal_features.sql.js): per signal type, the first matching
// feature of the YAML wins, then features are grouped by layer and ordered
// by rank (their position in the YAML), lowest rank at the bottom.

import fs from 'node:fs';
import yaml from 'yaml';

/** Loads the signal YAML: types, tag value types and features. */
export function loadSignalConfig(yamlPath) {
  const config = yaml.parse(fs.readFileSync(yamlPath, 'utf8'));
  return {
    types: config.types,
    tagTypes: Object.fromEntries(config.tags.map((tag) => [tag.tag, tag.type])),
    features: config.features.map((feature, rank) => ({ ...feature, rank })),
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

// First type of `layer` (in types order) carried by the feature's tags.
function primaryType(config, feature, layer) {
  return config.types
    .filter((type) => type.layer === layer)
    .find((type) => feature.tags.some((tag) => tag.tag === `railway:signal:${type.type}`))?.type;
}

/**
 * Resolves every signal feature of a node.
 * @returns {Map<string, Array<{type: string, description: string, rank: number|null,
 *   deactivated: boolean, icons: Array<{id: string, position: string}>, shadowed?: string[]}>>}
 *   Features per layer, bottom first.
 */
export function matchSignals(config, tags) {
  const layers = new Map();
  for (const { type, layer } of config.types) {
    const key = `railway:signal:${type}`;
    if (tags[key] === undefined) continue;

    const matching = config.features.filter((f) => f.tags.some((t) => t.tag === key) && matchesFeatureTags(config, tags, f));
    const feature = matching[0];
    let entry;
    if (!feature) {
      entry = { type, description: `Unknown signal (${type})`, rank: null, icons: [{ id: `general/signal-unknown-${type}`, position: 'center' }] };
    } else if (primaryType(config, feature, layer) === type) {
      const icons = feature.icon.map((icon) => resolveIcon(config, tags, icon)).filter(Boolean);
      // Later matching features of the same type are never drawn.
      const shadowed = matching.slice(1).filter((f) => primaryType(config, f, layer) === type).map((f) => f.description);
      entry = { type, description: feature.description, rank: feature.rank, icons, shadowed };
    } else {
      continue;
    }
    entry.deactivated = TRUE_VALUES.includes(tags[`${key}:deactivated`]);
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(entry);
  }
  for (const entries of layers.values()) {
    entries.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  }
  return layers;
}
