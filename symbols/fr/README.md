# SVG Optimization Script for OpenRailwayMap

This directory contains PowerShell scripts to prepare SVG files for the SDF sprite generator used by OpenRailwayMap (ORM).

## Purpose

The sprite generator cannot handle `<text>` elements, and raw SVGs are often too large. This script automates a two-phase process to prepare them:

1. **Phase 1 - Text to Paths:** Uses Inkscape to convert `<text>` and `<tspan>` elements into paths. This is required for compatibility with the sprite generator.
2. **Phase 2 - SVGO Optimization:** Uses SVGO to optimize all SVGs, reducing file size and cleaning up markup.

## Prerequisites

Before running the script, ensure the following tools are installed on your system:

*   **[PowerShell 7+](https://github.com/PowerShell/PowerShell)** (the script uses modern PowerShell features and is launched via `pwsh.exe`).
*   **[Inkscape](https://inkscape.org/)** (standard installation path under `%ProgramFiles%\Inkscape\bin` is required. Microsoft Store/MSIX versions are not supported).
*   **[Node.js](https://nodejs.org/)** (includes `npx`, which is used to run SVGO).

You can install them using `winget`:

```powershell
winget install --id Microsoft.PowerShell -e --force
winget install --id Inkscape.Inkscape -e --force
winget install OpenJS.NodeJS.LTS
```

## Usage

1. Open a terminal and navigate to this directory (`symbols/fr/`).
2. Run the wrapper script:

```cmd
optimize-svg.cmd
```

Alternatively, you can run the PowerShell script directly:

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\optimize-svg.ps1
```

## How it Works

*   **Backups:** Before any file is modified, it is backed up to the `_backup/` directory, preserving its relative path. The script never overwrites an existing backup, so the pristine originals are always preserved.
*   **Failure Handling:** If an individual file fails during Phase 1 or Phase 2, the script restores the original file from the backup and continues with the next file.
*   **Configuration:** The SVGO version is pinned in the script (`$script:SvgoVersion = "3"`) for reproducibility.

## Next Steps

After the script finishes successfully, you need to rebuild the relevant Docker services to see the changes in action:

```powershell
cd ..\..
docker compose up -d --build martin
docker compose stop proxy
docker compose rm -f proxy
docker compose up -d proxy
```

## Files

*   `optimize-svg.ps1` - The main PowerShell script containing the logic.
*   `optimize-svg.cmd` - A Windows batch wrapper to easily run the PowerShell script with the correct execution policy.
*   `README.md` - This file.
