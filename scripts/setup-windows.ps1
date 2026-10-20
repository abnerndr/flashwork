# Flashwork — Windows entry (delegates to the cross-platform setup.mjs).
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
& node "$Root\scripts\setup.mjs" @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
