# features-tools

Development helpers for `signals_railway_signals.yaml`.

## check-tags.mjs

Static analysis of the signal YAML. Reports issues that would otherwise
fail at Docker build time or produce silent mismatches between features
and the database schema.

### Requirements

- Node.js 21 or newer (uses `Object.groupBy`)
- The `yaml` package (installed via `npm install`)

### Setup

Run once from this directory:

```
npm install
```

### Usage

Run from this directory:

```
npm run check-tags
```

The script reads `signals_railway_signals.yaml` from the current
directory and prints its findings to stdout.

### Reported issues

**Section 1 — Tags used but not declared**

A tag is referenced in a feature (either in `tags:` or in an `icon.match`)
but is missing from the top-level `tags:` list. This is the most common
cause of "column does not exist" errors during import.

Fix: add the tag to the top-level list. Do not add `type: boolean`
unless the tag truly is a boolean.

**Section 2 — Tags declared more than once**

The same tag appears twice in the top-level `tags:` list.

Fix: remove the duplicate.

**Section 3 — Duplicated features**

Two features share the same country and description.

Fix: rename one of them or merge them.

**Section 4 — Duplicated tags within a feature**

The same tag appears twice in the `tags:` list of a single feature.

Fix: remove the duplicate.

**Section 5 — Duplicated static icon paths**

Two features of the same country reference the same static icon path
(dynamic paths containing `{}` are excluded). This is often intentional:
`features.mjs` merges such entries automatically.

Action: informational. Review only if the duplication is unexpected.

**Section 6 — Tags declared but never used**

A tag is present in the top-level `tags:` list but is never referenced
by any feature.

Action: informational. It may be intended for future features.

### When to run

After any edit to `signals_railway_signals.yaml`, before running 
`docker compose up --build`. It catches the most common cause of import
failures in a few seconds.

### Exit codes

The script always exits with code 0 and prints findings to stdout.
Sections 1–4 indicate blocking issues; sections 5–6 are informational.
