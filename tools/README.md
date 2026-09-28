# tools

Development helpers for the OpenRailwayMap project.

All tools are Node scripts. Each derives the project root from its own
location (`tools/` → project root), so they can be launched from any
directory without changing the working directory.

## Contents

| File                       | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `cli.mjs`                  | Single entry point that dispatches to the scripts below.         |
| `audit-svg.mjs`            | Audit of `symbols/fr` (preview, viewBox, warnings). HTML/text/JSON. |
| `check-yaml.mjs`           | Static analysis of `features/signals_railway_signals.yaml`.      |
| `optimize-svg.mjs`         | Text-to-path (Inkscape) + SVGO optimization of `symbols/fr`.     |
| `resize-svg.mjs`           | Set `width`/`height` from the `viewBox` for a subfolder.         |
| `lib/shared.mjs`           | Shared helpers: project paths, SVG parsing, colors, formatting.  |
| `lib/audit-template.html`  | HTML skeleton for the audit report.                              |
| `lib/audit-template.css`   | Styles for the audit report (dark mode included).                |
| `lib/audit-template.js`    | Client-side filtering, sorting and theme toggle.                 |
| `lib/audit-template.mjs`   | Loader that inlines CSS/JS and substitutes the data placeholders.|

## Path conventions

- Defaults resolve to `<project>/symbols/fr` and
  `<project>/features/signals_railway_signals.yaml`.
- Relative paths on the command line resolve against the current working
  directory.
- Backups created by `optimize-svg.mjs` live in `symbols/fr/_backup/`
  and are never overwritten.

## Requirements

- **Node.js 21 or newer**.
- **Inkscape** for Phase 1 of `optimize-svg.mjs` (standard install under
  `%ProgramFiles%\Inkscape\bin` on Windows, or `inkscape` on `PATH`).
  Microsoft Store/MSIX installations are not supported.

Install Inkscape and Node.js with `winget`:

```
winget install --id Inkscape.Inkscape -e --force
winget install OpenJS.NodeJS.LTS
```

## Setup

Install the two runtime dependencies (`svgo`, `yaml`) once:

```
cd tools
npm install
```

## Usage

### Via the dispatcher

`cli.mjs` forwards every extra argument to the target script, so
per-tool options work exactly as documented below.

```
node tools/cli.mjs audit
node tools/cli.mjs audit --format text
node tools/cli.mjs audit --root symbols/fr/boxes
node tools/cli.mjs check
node tools/cli.mjs optimize
node tools/cli.mjs resize --subdir signals --apply
```

`node tools/cli.mjs --help` lists the available commands;
`node tools/cli.mjs <command> --help` shows the options for one command.

### Via `npm run` (from `tools/`)

```
npm run audit         # audit-svg.mjs, HTML report
npm run audit:text    # audit-svg.mjs, text table on stdout
npm run check         # check-yaml.mjs
npm run optimize      # optimize-svg.mjs
npm run resize        # resize-svg.mjs --apply
```

### Directly (from anywhere)

```
node C:\dev\orm\tools\audit-svg.mjs
node C:\dev\orm\tools\resize-svg.mjs --subdir signals --apply
```

## Audit modes

`audit-svg.mjs` supports three output formats:

- `--format html` (default) — a self-contained HTML report with square
  previews, dark mode, filtering, and sorting. Print to PDF with
  Ctrl/Cmd+P.
- `--format text` — a compact table on stdout, one line per icon. Use it
  to review the viewBox values that must **not** be changed, since they
  are the reference for `resize-svg.mjs`.
- `--format json` — machine-readable, suitable for piping or CI.

### Text output legend

```
name.svg     viewBox=W × H     size   ✓|⚠   [TEXT] [INKSCAPE]
```

- `TEXT`     — the file contains non-empty `<text>` elements
  (Phase 1 of `optimize-svg.mjs` will convert them).
- `INKSCAPE` — the file still carries `inkscape:` or `sodipodi:` markup.

## Customizing the audit report

The report is assembled from four files, each editable in isolation:

- `lib/audit-template.html` — structure and data placeholders.
- `lib/audit-template.css`  — visual style.
- `lib/audit-template.js`   — client-side behaviour.
- `lib/audit-template.mjs`  — loader that inlines CSS/JS and substitutes
  the placeholders.

`audit-svg.mjs` only supplies the values for these placeholders:

| Placeholder      | Value                                            |
| ---------------- | ------------------------------------------------ |
| `{{TITLE}}`      | Scan root label (e.g. `fr`).                     |
| `{{TOTAL}}`      | Number of icons.                                 |
| `{{TOTAL_PLURAL}}` | `''` or `'s'`.                                 |
| `{{MIN}}`        | viewBox threshold.                               |
| `{{WARN_COUNT}}` | Number of warnings.                              |
| `{{EMPTY_STATE}}`| Empty-state block (empty string when icons found). |
| `{{CARDS}}`      | All `<article class="card">` blocks.             |

`{{CSS}}` and `{{JS}}` are filled automatically by the loader.

Add a new placeholder by inserting `{{YOUR_TOKEN}}` in the HTML and
passing a matching key to `renderAuditHtml({ ... })`.

## Next steps (after optimizing icons)

```
cd ..
docker compose up -d --build martin
docker compose stop proxy
docker compose rm -f proxy
docker compose up -d proxy
```