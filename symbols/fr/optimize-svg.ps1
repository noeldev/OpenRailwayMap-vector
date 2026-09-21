# optimize-svg.ps1
#
# Prepares SVG files for the SDF sprite generator by running two phases:
#
#   Phase 1 - Convert <text> / <tspan> elements to paths using Inkscape.
#             Required because the sprite generator cannot handle text.
#
#   Phase 2 - Optimize all SVGs with SVGO.
#             Reduces file size and cleans up markup.
#
# Files are backed up to _backup/ on first modification and never
# overwritten, so the pristine originals are always preserved.
#
# Run this script from symbols/fr, or via the accompanying .cmd wrapper.

# ============================================================================
# Configuration
# ============================================================================

# Name of the backup subdirectory, relative to the script directory.
# The leading underscore ensures it sorts first and is not picked up by
# the file scanners.
$script:BackupDirName = "_backup"

# SVGO major version to pin for reproducibility.
$script:SvgoVersion = "3"

# ============================================================================
# Prerequisites
# ============================================================================

<#
.SYNOPSIS
    Locates the Inkscape executable.
.DESCRIPTION
    Only the standard install path under %ProgramFiles%\Inkscape\bin is
    considered. Microsoft Store (MSIX) installations are explicitly not
    supported: their executables are sandboxed by Windows and cannot be
    launched from another process.
.OUTPUTS
    Full path to inkscape.exe, or $null if not found.
#>
function Find-InkscapeExecutable {
    $candidate = Join-Path $env:ProgramFiles "Inkscape\bin\inkscape.exe"
    if (Test-Path $candidate) { return $candidate }
    return $null
}

<#
.SYNOPSIS
    Locates the npx batch wrapper required to run SVGO.
.DESCRIPTION
    npx is bundled with Node.js. There are typically three wrappers:
      - npx.cmd  (batch, directly runnable via Start-Process)
      - npx.ps1  (PowerShell, requires pwsh.exe to launch)
      - npx      (Unix shell script)
    Only npx.cmd is selected, as it is a proper Win32 executable.
.OUTPUTS
    Full path to npx.cmd, or $null if not found.
#>
function Find-NpxExecutable {
    # Prefer npx.cmd, which Start-Process can launch directly.
    $cmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    # Fallback: manually construct the path next to node.exe.
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $candidate = Join-Path (Split-Path $node.Source -Parent) "npx.cmd"
        if (Test-Path $candidate) { return $candidate }
    }

    return $null
}

<#
.SYNOPSIS
    Prints an error message when Inkscape could not be located.
#>
function Write-InkscapeNotFoundError {
    Write-Host "Inkscape not found: skipping text-to-path conversion." -ForegroundColor Yellow
    Write-Host "  Expected: `$env:ProgramFiles\Inkscape\bin\inkscape.exe" -ForegroundColor Yellow
    Write-Host "  Install : winget install --id Inkscape.Inkscape -e --force" -ForegroundColor Yellow
}

<#
.SYNOPSIS
    Prints an error message when Node.js / npx is not available.
#>
function Write-NpxNotFoundError {
    Write-Host "ERROR: npx.cmd not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "npx is bundled with Node.js. Install it via:" -ForegroundColor Yellow
    Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow
}

# ============================================================================
# File Discovery
# ============================================================================

<#
.SYNOPSIS
    Finds all SVG files under the given directory.
.PARAMETER Root
    Root directory to scan.
.PARAMETER ExcludedDirName
    Name of a subdirectory to skip (the backup directory).
.OUTPUTS
    Array of FileInfo objects (may be empty).
#>
function Find-SvgFiles {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter(Mandatory)] [string] $ExcludedDirName
    )

    Get-ChildItem -Path $Root -Recurse -Filter *.svg -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notlike "*$ExcludedDirName*" }
}

<#
.SYNOPSIS
    Determines whether an SVG file contains at least one <text> element
    with actual (non-whitespace) content, ignoring nested tags.
.DESCRIPTION
    Strips all inner tags from the content of each <text>...</text> block
    and checks whether what remains has any non-whitespace character.
    This correctly handles:
      <text>Hello</text>                     -> true
      <text><tspan>Hello</tspan></text>      -> true
      <text></text>                          -> false
      <text>   </text>                       -> false
      <text><tspan></tspan></text>           -> false
.PARAMETER FilePath
    Absolute path of the SVG file to inspect.
.OUTPUTS
    Boolean.
#>
function Test-SvgHasNonEmptyText {
    param([Parameter(Mandatory)] [string] $FilePath)

    $content = Get-Content $FilePath -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return $false }

    $matches = [regex]::Matches($content, '<text[^>]*>(.*?)</text>', 'Singleline')
    foreach ($m in $matches) {
        # Remove nested tags and check what's left
        $innerText = $m.Groups[1].Value -replace '<[^>]+>', ''
        if ($innerText -match '\S') {
            return $true
        }
    }

    return $false
}

<#
.SYNOPSIS
    Finds all SVG files under the given directory that contain non-empty
    text elements.
.PARAMETER Root
    Root directory to scan.
.PARAMETER ExcludedDirName
    Name of a subdirectory to skip (the backup directory).
.OUTPUTS
    Array of FileInfo objects (may be empty).
#>
function Find-SvgFilesWithText {
    param(
        [Parameter(Mandatory)] [string] $Root,
        [Parameter(Mandatory)] [string] $ExcludedDirName
    )

    Find-SvgFiles -Root $Root -ExcludedDirName $ExcludedDirName |
        Where-Object { Test-SvgHasNonEmptyText -FilePath $_.FullName }
}

# ============================================================================
# Backup Handling
# ============================================================================

<#
.SYNOPSIS
    Ensures the backup directory exists.
.OUTPUTS
    The backup directory path.
#>
function Initialize-BackupDirectory {
    param([Parameter(Mandatory)] [string] $BackupDir)

    if (-not (Test-Path $BackupDir)) {
        New-Item -ItemType Directory -Path $BackupDir | Out-Null
        Write-Host "Created backup directory: $BackupDir" -ForegroundColor Cyan
    }
    return $BackupDir
}

<#
.SYNOPSIS
    Copies a file to the backup directory, preserving its relative path.
.DESCRIPTION
    Does not overwrite an existing backup: the first backup of a file is
    considered the pristine original and is preserved across runs.
.OUTPUTS
    Absolute path of the backup file (existing or newly created).
#>
function Backup-File {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string] $RootDir,
        [Parameter(Mandatory)] [string] $BackupDir
    )

    $relative = $FilePath.Substring($RootDir.Length).TrimStart('\')
    $backupPath = Join-Path $BackupDir $relative
    $backupParent = Split-Path $backupPath -Parent

    if (-not (Test-Path $backupParent)) {
        New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
    }

    if (-not (Test-Path $backupPath)) {
        Copy-Item -Path $FilePath -Destination $backupPath -Force
    }

    return $backupPath
}

# ============================================================================
# Phase 1: Text to Paths
# ============================================================================

<#
.SYNOPSIS
    Converts a single SVG file's text elements to paths using Inkscape.
.DESCRIPTION
    Invokes Inkscape via Start-Process with output redirected to temporary
    files. This avoids a PowerShell 7 issue where '2>&1' triggers an attempt
    to set StandardOutputEncoding on Inkscape, which is a GUI application
    without a real stdout stream.

    Action list:
      select-all       -> select all objects on the canvas
      object-to-path   -> convert text and other objects to paths
      export-filename  -> target output path
      export-plain-svg -> strip Inkscape/Sodipodi namespaces
      export-do        -> execute the export
.OUTPUTS
    Boolean indicating success.
#>
function Convert-SvgTextToPaths {
    param(
        [Parameter(Mandatory)] [string] $InkscapePath,
        [Parameter(Mandatory)] [string] $FilePath
    )

    $actions = "select-all;object-to-path;export-filename:$FilePath;export-plain-svg;export-do"

    $tempOut = [System.IO.Path]::GetTempFileName()
    $tempErr = [System.IO.Path]::GetTempFileName()

    try {
        $process = Start-Process -FilePath $InkscapePath `
            -ArgumentList @($FilePath, "--actions=$actions") `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $tempOut `
            -RedirectStandardError $tempErr

        if ($process.ExitCode -ne 0) {
            $output = (Get-Content $tempOut -Raw -ErrorAction SilentlyContinue) +
                      (Get-Content $tempErr -Raw -ErrorAction SilentlyContinue)
            Write-Host "  FAILED (exit $($process.ExitCode)): $output" -ForegroundColor Red
            return $false
        }

        if (-not (Test-Path $FilePath)) {
            Write-Host "  FAILED: output file was not created" -ForegroundColor Red
            return $false
        }

        if (Test-SvgHasNonEmptyText -FilePath $FilePath) {
            Write-Host "  WARN: file still contains non-empty text elements" -ForegroundColor Magenta
            return $false
        }

        return $true
    }
    finally {
        Remove-Item -Path $tempOut, $tempErr -Force -ErrorAction SilentlyContinue
    }
}

<#
.SYNOPSIS
    Converts a batch of SVG files, backing up originals and restoring them
    on individual failures.
.OUTPUTS
    Hashtable with 'Converted' and 'Failed' counts.
#>
function Invoke-TextConversionBatch {
    param(
        [Parameter(Mandatory)] [System.IO.FileInfo[]] $Files,
        [Parameter(Mandatory)] [string] $InkscapePath,
        [Parameter(Mandatory)] [string] $RootDir,
        [Parameter(Mandatory)] [string] $BackupDir
    )

    $converted = 0
    $failed = 0
    $total = $Files.Count
    $index = 0

    foreach ($file in $Files) {
        $index++
        $relative = $file.FullName.Substring($RootDir.Length).TrimStart('\')
        Write-Host "  [$index/$total] $relative" -ForegroundColor Yellow

        $backupPath = Backup-File -FilePath $file.FullName -RootDir $RootDir -BackupDir $BackupDir

        if (Convert-SvgTextToPaths -InkscapePath $InkscapePath -FilePath $file.FullName) {
            $converted++
        }
        else {
            Copy-Item -Path $backupPath -Destination $file.FullName -Force
            Write-Host "    Restored original" -ForegroundColor Yellow
            $failed++
        }
    }

    return @{ Converted = $converted; Failed = $failed }
}

# ============================================================================
# Phase 2: SVGO Optimization
# ============================================================================

<#
.SYNOPSIS
    Runs SVGO on a single SVG file, overwriting it in place.
.DESCRIPTION
    Invokes npx with SVGO pinned to a major version and the --multipass
    flag for maximum compression. Output is captured to temporary files
    to avoid interleaving with the parent console.
.OUTPUTS
    Boolean indicating success.
#>
function Invoke-Svgo {
    param(
        [Parameter(Mandatory)] [string] $NpxPath,
        [Parameter(Mandatory)] [string] $SvgoVersion,
        [Parameter(Mandatory)] [string] $FilePath
    )

    $tempOut = [System.IO.Path]::GetTempFileName()
    $tempErr = [System.IO.Path]::GetTempFileName()

    try {
        $process = Start-Process -FilePath $NpxPath `
            -ArgumentList @('-y', "svgo@$SvgoVersion", '--multipass', $FilePath) `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $tempOut `
            -RedirectStandardError $tempErr

        if ($process.ExitCode -ne 0) {
            $errOutput = Get-Content $tempErr -Raw -ErrorAction SilentlyContinue
            Write-Host "    FAILED (exit $($process.ExitCode)): $errOutput" -ForegroundColor Red
            return $false
        }

        if (-not (Test-Path $FilePath)) {
            Write-Host "    FAILED: output file is missing" -ForegroundColor Red
            return $false
        }

        return $true
    }
    finally {
        Remove-Item -Path $tempOut, $tempErr -Force -ErrorAction SilentlyContinue
    }
}

<#
.SYNOPSIS
    Optimizes a batch of SVG files, backing up originals (if not already
    backed up) and restoring them on individual failures.
.OUTPUTS
    Hashtable with 'Optimized', 'Failed', and 'SavedBytes'.
#>
function Invoke-SvgoBatch {
    param(
        [Parameter(Mandatory)] [System.IO.FileInfo[]] $Files,
        [Parameter(Mandatory)] [string] $NpxPath,
        [Parameter(Mandatory)] [string] $SvgoVersion,
        [Parameter(Mandatory)] [string] $RootDir,
        [Parameter(Mandatory)] [string] $BackupDir
    )

    $optimized = 0
    $failed = 0
    $savedBytes = 0
    $total = $Files.Count
    $index = 0

    foreach ($file in $Files) {
        $index++
        $relative = $file.FullName.Substring($RootDir.Length).TrimStart('\')
        $sizeBefore = (Get-Item $file.FullName).Length

        # Backup on first modification only (skip if already backed up).
        $backupPath = Backup-File -FilePath $file.FullName -RootDir $RootDir -BackupDir $BackupDir

        if (Invoke-Svgo -NpxPath $NpxPath -SvgoVersion $SvgoVersion -FilePath $file.FullName) {
            $sizeAfter = (Get-Item $file.FullName).Length
            $delta = $sizeBefore - $sizeAfter
            $savedBytes += $delta
            $percent = if ($sizeBefore -gt 0) { [Math]::Round($delta * 100 / $sizeBefore, 1) } else { 0 }
            Write-Host "  [$index/$total] $relative ($sizeBefore -> $sizeAfter bytes, -$percent%)" -ForegroundColor Green
            $optimized++
        }
        else {
            Copy-Item -Path $backupPath -Destination $file.FullName -Force
            Write-Host "  [$index/$total] $relative (restored original)" -ForegroundColor Yellow
            $failed++
        }
    }

    return @{
        Optimized  = $optimized
        Failed     = $failed
        SavedBytes = $savedBytes
    }
}

# ============================================================================
# Reporting
# ============================================================================

<#
.SYNOPSIS
    Prints the final summary of both phases.
#>
function Write-FinalSummary {
    param(
        [Parameter(Mandatory)] [hashtable] $TextResult,
        [Parameter(Mandatory)] [hashtable] $SvgoResult,
        [Parameter(Mandatory)] [string] $BackupDir
    )

    Write-Host ""
    Write-Host "===== Summary =====" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Phase 1 - Text to paths:" -ForegroundColor Cyan
    Write-Host "  Converted : $($TextResult.Converted)" -ForegroundColor Green
    Write-Host "  Failed    : $($TextResult.Failed)" -ForegroundColor $(if ($TextResult.Failed) { "Red" } else { "Green" })
    Write-Host ""
    Write-Host "Phase 2 - SVGO optimization:" -ForegroundColor Cyan
    Write-Host "  Optimized  : $($SvgoResult.Optimized)" -ForegroundColor Green
    Write-Host "  Failed     : $($SvgoResult.Failed)" -ForegroundColor $(if ($SvgoResult.Failed) { "Red" } else { "Green" })
    Write-Host "  Total saved: $([Math]::Round($SvgoResult.SavedBytes / 1KB, 1)) KB" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Backups: $BackupDir" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  cd ..\.."
    Write-Host "  docker compose up -d --build martin"
    Write-Host "  docker compose stop proxy; docker compose rm -f proxy; docker compose up -d proxy"
}

# ============================================================================
# Main
# ============================================================================

function Invoke-Main {
    $scriptDir = $PSScriptRoot
    Write-Host "Working directory: $scriptDir" -ForegroundColor Cyan
    Write-Host ""

    # Result placeholders for the final summary
    $textResult = @{ Converted = 0; Failed = 0 }
    $svgoResult = @{ Optimized = 0; Failed = 0; SavedBytes = 0 }

    # --- Prepare backup directory ---
    $backupDir = Initialize-BackupDirectory -BackupDir (Join-Path $scriptDir $script:BackupDirName)

    # --- Phase 1: Text to paths (optional, requires Inkscape) ---
    Write-Host ""
    Write-Host "Phase 1: Text to paths" -ForegroundColor Cyan

    $inkscapePath = Find-InkscapeExecutable
    if (-not $inkscapePath) {
        Write-InkscapeNotFoundError
    }
    else {
        Write-Host "  Inkscape: $inkscapePath" -ForegroundColor Cyan
        $textFiles = Find-SvgFilesWithText -Root $scriptDir -ExcludedDirName $script:BackupDirName

        if (-not $textFiles -or $textFiles.Count -eq 0) {
            Write-Host "  No SVG files with non-empty text elements found." -ForegroundColor Green
        }
        else {
            Write-Host "  Found $($textFiles.Count) file(s) to convert." -ForegroundColor Cyan
            $textResult = Invoke-TextConversionBatch -Files $textFiles `
                -InkscapePath $inkscapePath `
                -RootDir $scriptDir -BackupDir $backupDir
        }
    }

    # --- Phase 2: SVGO optimization (requires npx) ---
    Write-Host ""
    Write-Host "Phase 2: SVGO optimization" -ForegroundColor Cyan

    $npxPath = Find-NpxExecutable
    if (-not $npxPath) {
        Write-NpxNotFoundError
        return 1
    }
    Write-Host "  npx: $npxPath" -ForegroundColor Cyan

    $allFiles = Find-SvgFiles -Root $scriptDir -ExcludedDirName $script:BackupDirName
    if (-not $allFiles -or $allFiles.Count -eq 0) {
        Write-Host "  No SVG files found." -ForegroundColor Green
    }
    else {
        Write-Host "  Found $($allFiles.Count) file(s) to optimize." -ForegroundColor Cyan
        $svgoResult = Invoke-SvgoBatch -Files $allFiles `
            -NpxPath $npxPath -SvgoVersion $script:SvgoVersion `
            -RootDir $scriptDir -BackupDir $backupDir
    }

    # --- Final summary ---
    Write-FinalSummary -TextResult $textResult -SvgoResult $svgoResult -BackupDir $backupDir
    return 0
}

# ============================================================================
# Entry point
# ============================================================================

exit (Invoke-Main)
