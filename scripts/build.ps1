# Flashwork — production bundle on native Windows (NSIS / MSI).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Orch = Join-Path $Root "apps\orchestrator"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js >= 22 is required."
}
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
  Write-Error "Rust is required."
}

if (-not (Test-Path (Join-Path $Orch "node_modules"))) {
  npm --prefix $Orch install
}

Write-Host "==> Flashwork production build (instalador do SO atual)"
Set-Location $Root
npm run installer
Write-Host ""
Write-Host "Artifacts: $Orch\src-tauri\target\release\bundle\"
