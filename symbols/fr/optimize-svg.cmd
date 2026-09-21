@echo off
rem Wrapper to run optimize-svg.ps1 with ExecutionPolicy Bypass.
rem Uses pwsh.exe (PowerShell 7+ for the ?? operator and modern features).

pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0optimize-svg.ps1"

echo.
echo Script finished. Press any key to close this window.
pause >nul
