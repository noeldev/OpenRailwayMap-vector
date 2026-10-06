# Tools

Command-line tools supporting the ORM-vector icon set: auditing generated
SVGs, static-checking the YAML, preparing icons for the sprite build,
setting width/height from each icon's viewBox, and generating the
digit/number overlay SVGs used by the speed/length/vehicle-count plates and
the layered light signal icons.

## Requirements

- Node.js 18+
- `npm install` in this folder (installs `@xmldom/xmldom`, `svgo`, `yaml`)
- Inkscape on `PATH` (only needed by `optimize`, for text-to-path conversion)

## Running a tool

Everything goes through the single entry point `orm.mjs`:

```
node tools/orm.mjs <command> [args...]
node tools/orm.mjs <command> --help
node tools/orm.mjs --help
```

| Command    | Script               | Purpose                                             |
|------------|-----------------------|------------------------------------------------------|
| `audit`    | `audit-svg.mjs`       | HTML/text/JSON audit of `symbols/fr`                  |
| `check`    | `check-yaml.mjs`      | Static analysis of `signals_railway_signals.yaml`     |
| `optimize` | `optimize-svg.mjs`    | Text-to-path (Inkscape) + SVGO on `symbols/fr`        |
| `resize`   | `resize-svg.mjs`      | Set width/height from viewBox                         |
| `aspects`  | `generate-aspects.mjs`| Generate overlay SVGs (numbers, signal aspects) from templates |
| `clean-templates` | `clean-templates.mjs` | Resolve leftover transforms on the aspect templates   |

Each command can also be run directly (`node tools/audit-svg.mjs ...`);
`orm.mjs` just saves having to remember which file does what.

### audit

```
node tools/orm.mjs audit                        # HTML report (default)
node tools/orm.mjs audit --format text          # plain text table on stdout
node tools/orm.mjs audit --format json          # machine-readable
node tools/orm.mjs audit --root symbols/fr/boxes --min 100
node tools/orm.mjs audit --out report.html
```

### check

```
node tools/orm.mjs check                        # checks signals_railway_signals.yaml
node tools/orm.mjs check path/to/other.yaml      # checks a different file
node tools/orm.mjs check --verbose               # also lists sections 5 and 6 in full
```

Six report sections. Sections 1-4 are correctness checks: undeclared tags,
tags declared more than once, duplicated features (same country,
description *and* tag set), and tags repeated within one feature - every
line they print is worth a look. Sections 5-6 are cross-reference listings
that are informative even when nothing is wrong (a plate icon reused by
dozens of features, or a tag that documents more of the OSM schema than
this file currently exercises), so by default they only print a count;
pass `--verbose` to see the full listing.

### optimize

```
node tools/orm.mjs optimize --subdir signals     # one family, recursively
node tools/orm.mjs optimize --all                # the whole symbols/fr tree
node tools/orm.mjs optimize --help
```

One of `--subdir` or `--all` is required, since files are rewritten in
place. Runs the same tidy pass as `clean-templates` (see below), then
Inkscape text-to-path conversion (retried up to 5 passes on files that
still contain text), then SVGO. A pristine copy of every file it touches is
saved once before the first modification, with the same layout as `resize`:
`tools/_backup/<subdir>/` for a `--subdir` run, `tools/_backup/` for `--all`.

### resize

```
node tools/orm.mjs resize                          # dry-run, boxes/
node tools/orm.mjs resize --apply
node tools/orm.mjs resize --subdir signals --apply
node tools/orm.mjs resize --subdir boards --scale 2.5 --apply
node tools/orm.mjs resize --all --apply            # every subdir, one pass
node tools/orm.mjs resize --apply --no-backup
```

Computes `width`/`height` from each file's existing `viewBox` (scaled by
`--scale` percent, rounded to the nearest 0.25) and writes them onto the
`<svg>` tag. The `viewBox` itself is never modified - only the two
presentation attributes change, so the icon's internal coordinate system
stays stable while its rendered size does not. Walks the target folder
recursively, so nested families (e.g. `boxes/single/`, `boxes/TIV/`) are
included, not just files directly in it - `--subdir` targets one folder
under `symbols/fr` this way, and `--all` (mutually exclusive with
`--subdir`) targets the whole `symbols/fr` tree the same way, for a run
that needs to sweep every family in one pass. A pristine copy of every
file it applies to is saved once before the first modification - to
`tools/_backup/<subdir>/` for a `--subdir` run, or plain `tools/_backup/`
(mirroring the full `symbols/fr` layout) for `--all` - the same convention
and backup directory `optimize` uses; pass `--no-backup` to skip it.

### aspects

See the dedicated section below.

## Regenerating the aspect overlays

"Aspects" are the per-value SVGs a plate or board needs: a `TIV-D_B_{90}.svg`
overlay for a speed plate, a `V_split_{10}V_top.svg` overlay for a split
vehicle-count sign, a whole `L{170}.svg` file for a train-length plate, and
so on. There are 400+ of these on disk, all mechanically derived from a much
smaller set of hand-drawn templates - `generate-aspects.mjs` is what
(re)derives them, so a template fix doesn't mean redrawing every value by
hand.

#### Inputs

```
tools/aspects/
  spec.json           # the job list: which template produces which files
  templates/
    signs/*.svg        # hand-drawn templates, one per plate/board family
    boards/*.svg
    boxes/*.svg
    signals/*.svg      # light signal targets (C, F, H, A, K, R, dwarf...)
```

The first folder of a job's template path is its *group* (`signs`,
`boards`, `boxes`, `signals`), used to select which jobs to run.

A template is a normal SVG containing the plate's shape plus one or more
placeholder `<text>` elements (whatever value they currently show is
irrelevant - it's replaced for every generated file).

#### What a job does

`spec.json` is `{ "jobs": [...] }`. Each job names one template and the set
of values to render it with. A job runs in one of five modes:

| Mode (`job.mode`) | Produces | Used for |
|---|---|---|
| `split` (default) | one shape-only base file, plus one text-only overlay file per value (per slot, if more than one) | the usual case: speed/length plates whose shape and number are separate, composited layers |
| `digits` | one shape-only base, plus one overlay per value with *all* its digits set at once | a template that spells a number out as several separately-positioned `<text>` elements instead of one multi-character tspan, for a family that still needs the shape/number split (base+overlay) |
| `fused` | one self-contained file per value (shape + number together), plus an optional shape-only "empty"/placeholder base | a family whose YAML icon has only one state, so a separate base+overlay pair would be pointless (e.g. the `L...` train-length plates, `TIV-D_B`, the pentagonal TIV signs). Works with a single `<text>` element (whole value as one string) or several (one digit per element, left-to-right by x position, same per-element assignment as `digits` mode - e.g. the SNCF-Lightbox box digit displays) - the difference from `digits` is that the shape is never stripped out, so each value's file is complete and self-contained |
| `lights` | one all-unlit base, one layer per aspect, per optional part and for the deactivated cross, plus flattened examples | light signal targets: every signal type drawn on the same target (Carre, Carre violet, Semaphore...) shares the same base and layers. See "Light signal targets" below |
| `compose` | one example file flattening existing icons of the symbols tree (`--symbols`, default `symbols/fr`), each layer centered on the first | the `exampleIcon` of a feature whose icon is only a stack of layers (e.g. a lightbox and its lettering): `{ "name", "mode": "compose", "layers": [ "boxes/double", "boxes/double/D_left", ... ] }` |

Job fields:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Used in the console summary and in the default filename templates |
| `template` | yes | Template path, relative to `--templates` |
| `base` | split/digits: yes; fused: optional | Output path (no extension) for the shape-only base/placeholder file |
| `overlayDir` | split/digits/fused: yes | Directory the per-value file(s) are written into |
| `values` | yes (unless `valuesBySlot` is used) | Values to render |
| `valuesBySlot` | split only, optional | `{ slotName: [values] }`, when slots don't share the same range (overrides `values`) |
| `slots` | split only, optional | Slot names, **top-to-bottom** (text elements are matched to slots by vertical position in the template, not document order). Defaults to `["centered"]` for a single `<text>`, or `["slot0", "slot1", ...]` |
| `fileName` | optional | Filename template; see below. Defaults to `"{name}_{v}"` (centered) or `"{name}_{v}_{slot}"` (slotted) |
| `displayDivisor` | split/fused, optional | When set, the text shows `floor(value / displayDivisor)` while the filename still uses the raw value (e.g. a pentagonal sign named `..._{30}.svg` that only ever displays the tens digit, "3") |
| `example` | split only, optional | Generates one extra composite file, `<group>/examples/<base name>.svg`: the base shape with each slot's overlay baked in, for use as a YAML `exampleIcon:`. A single value for a one-slot job, or `{ slotName: value, ... }` for a multi-slot job (see below) |

A `fused` job's `base` and a `split`/`digits` job's `example` are both
optional convenience outputs, not required by the mode itself - most jobs in
`spec.json` omit them once that family's "nothing selected" icon or
composite preview is finalized and already committed under `symbols/fr`, so
re-running `aspects --out symbols/fr` never regenerates or overwrites it
(same reasoning as `V_U-turn`'s hand-drawn empty icon). Set `base`/`example`
only while a new family has no such file yet.

`fileName` tokens: `{name}` (the job's `name`), `{v}` (the value, always
rendered brace-wrapped, e.g. `50` -> `{50}`, matching the on-disk naming
convention the renderer expects), `{slot}` (slot name). Most families use
the value-last default (`TIV-D_B_{100}`), but some put it first instead
(`fileName: "{v}{name}"` for the V signs: `{5}V`).

#### Light signal targets (`mode: "lights"`)

A `lights` template has no `<text>`; its elements carry class tokens
instead, and nothing else:

| Class | Meaning |
|---|---|
| aspect tokens, e.g. `class="S C"` | a lamp (or a lit-only figure such as the white cross of the intermediate signal), drawn unlit in the base; the tokens are the aspects that light it, and each aspect layer redraws it in that token's color. The sighting light is a lamp like any other: `class="O"` |
| a token listed in the job's `parts`, e.g. `class="cache"` | equipment only some signal types of the target have (the mask on the white lamp of a Carre or Semaphore, absent on a Carre violet): left out of the base and written as its own `<target>-<token>` layer, as drawn |

The spec-wide `lightColors` object gives the color of each token.

Job fields (besides `name`, `template`, `base`, `overlayDir`):

| Field | Required | Meaning |
|---|---|---|
| `aspects` | yes | `{ "<aspect>": "<token>+<token>" }`, one layer `<name>-<aspect>.svg` each, e.g. `"R-A": "R+A+O"`, `"D": "DJ+DR"`. List `O` in every aspect that lights the sighting light |
| `parts` | optional | Tokens written as separate layers instead of being in the base |
| `deactivated` | optional | `{ cx, cy, width, height, thickness }`: layer `<name>-deactivated.svg` holding the St Andrew's cross, in base coordinates (square box on the tall targets, flat on the dwarf ones). Its viewBox is grown symmetrically around the base center, since the renderer composites layers center-on-center |
| `examples` | optional | `[ [ "<layer>", ... ], ... ]`: each list of layers (parts, aspects, `deactivated`) is flattened onto the base into one standalone file `<group>/examples/<name>-<aspect>.svg` (parts are drawn but left out of the name, e.g. `[ "cache", "C" ]` gives `C-C`), used as the YAML `exampleIcon` (taginfo and the JOSM presets need a single SVG). Features illustrated the same way share one example |

Like the other modes, no width/height is written: `resize` sets them from
the viewBox, so every layer keeps the same scale. The YAML stacks the
layers, base first:

```yaml
exampleIcon: 'fr/signals/examples/C-C'
icon:
  - default: 'fr/signals/C'                    # unlit base, always first
  - default: 'fr/signals/aspects/C-cache'      # Carre and Semaphore only
  - match: 'railway:signal:main:states'
    cases:
      - { any: [ 'FR:A', 'FR:(A)' ], value: 'fr/signals/aspects/C-A' }
    default: 'fr/signals/aspects/C-C'
```

#### Composite examples

Every flattened example, whatever the mode, is written to an `examples`
folder at the root of its group (`signs/examples`, `boards/examples`,
`signals/examples`...), so examples never mix with the icons the renderer
composites.

A plate built from a separate base + overlay pair has no single file that
shows "what does this whole thing look like" - which is what a YAML
`exampleIcon:` needs. Setting `job.example` on a `split` job generates one
extra file, `<group>/examples/<base name>.svg`, with the chosen value's overlay(s)
already composited onto the base:

```json
{ "...": "...", "slots": ["top", "bottom"], "example": { "top": 60, "bottom": 80 } }
```

For a single-slot job, `example` is just the value itself (`"example": 90`).
This only covers jobs you opt into - it does not run for every job, so a
family with no `example` field keeps producing base + overlays only, same
as before.

A `fused` template whose text is a mix of fixed wording and a value (e.g.
"L 200 RBT") only has its digit run replaced - "L" and "RBT" pass through
untouched. Centering such a plate, including a leading decorative letter
like the "L" on the length plates, just needs `text-anchor="middle"` and a
single `<text>`/`<tspan>` holding the whole string: the renderer's own text
layout keeps it centered for every value, with no per-template font-metrics
configuration needed.

#### Running it

```
node tools/orm.mjs aspects --all
node tools/orm.mjs aspects --group signals
node tools/orm.mjs aspects --group signs,boards
```

One of `--group` or `--all` is required, so a commit touching one family
only regenerates that family.

With no `--out`, nothing in the project is touched: output goes to a fresh
temp folder (printed at the top of the run) so you can review the result
before it goes anywhere near `symbols/fr`. Once you're happy with it:

```
node tools/orm.mjs aspects --group signals --out symbols/fr
```

This writes straight into the real icon tree, overwriting any existing file
at the same path. Useful options:

```
node tools/orm.mjs aspects --all --spec tools/aspects/spec.json      # default spec
node tools/orm.mjs aspects --all --templates tools/aspects/templates # default templates
node tools/orm.mjs aspects --all --symbols symbols/fr                # default icon tree (compose jobs)
node tools/orm.mjs aspects --all --out symbols/fr
node tools/orm.mjs aspects -h
```

Re-running regenerates every selected job's files from the current templates - it's
meant to be re-run as a whole after touching a template, not patched by
hand. If a template changed shape but not text layout, this is also the
simplest way to propagate that change to all its generated values at once.

#### Cleaning the templates

```
node tools/orm.mjs clean-templates
node tools/orm.mjs clean-templates --no-backup
```

Resolves leftover `transform="..."` attributes on the hand-drawn templates
(Inkscape rotate/scale/skew noise) into plain coordinates - deliberately
not via SVGO, which would also rewrite every untransformed shape into a
`<path>`. Also runs the shared cosmetic tidy pass from
`tools/lib/svg-tidy.mjs` (the same one `optimize` runs on `symbols/fr`):
shorter colors, no stray `px`/decimal noise, no dead text attributes - see
that file's comments for the exact rules. That pass snaps over-precise
coordinates to a 2.5-unit design grid, but never on a file whose viewBox is
smaller than `audit`'s own `--min` warning threshold (100 by default,
`DEFAULT_MIN_VIEWBOX_DIM` in `tools/lib/shared.mjs`) - on a small icon that
step is large enough to visibly distort it, so those are left exactly as
drawn and are meant to be checked by hand, the same ones `audit` flags.

Run this once after drawing or editing a template, before `aspects`.
Backs up each file it changes to `tools/_backup/aspects-templates/` first,
same convention as `optimize`; pass `--no-backup` to skip it. Templates
are written with CRLF line endings, like every other file.

#### Adding a new family

1. Drop the hand-drawn template SVG into `tools/aspects/templates/signs/` or
   `.../boards/`.
2. Add a job to `spec.json` (copy the closest existing one and adjust
   `template`/`base`/`overlayDir`/`values`/`mode`). A `_source` comment next
   to the job documenting which YAML regex/tag it corresponds to is not
   required by the script but keeps the two in sync by eye - every existing
   job has one.
3. Run `node tools/orm.mjs aspects --group <group>` (no `--out`) and check the files in the
   temp folder.
4. Re-run with `--out symbols/fr` once satisfied.

A few jobs in `spec.json` are flagged `PROVISIONAL` in their `_source`
comment - their base filenames have no prior example file to confirm them
against, unlike the others. Treat those filenames as not yet final.

## Project layout

```
<project root>/
  features/
    signals_railway_signals.yaml   # DEFAULT_YAML_FILE
  symbols/fr/                      # DEFAULT_SVG_ROOT - the real icon tree
  tools/
    orm.mjs                        # entry point
    audit-svg.mjs
    check-yaml.mjs
    optimize-svg.mjs
    resize-svg.mjs
    generate-aspects.mjs
    lib/
      shared.mjs                   # PROJECT_ROOT / DEFAULT_* / shared helpers
      audit-template.{mjs,html,css,js}
    aspects/
      spec.json
      templates/{signs,boards}/*.svg
    _backup/                       # created by `optimize`, gitignored
```

All the `DEFAULT_*` paths above are computed from the script's own location
(`tools/lib/shared.mjs`), so every command works the same regardless of the
current working directory it's run from.
