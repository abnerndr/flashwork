# Flashwork — open the desktop app (Tauri + Vite) on native Windows.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Orch = Join-Path $Root "apps\orchestrator"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js >= 22 is required."
}
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
  Write-Error "Rust is required. Run .\scripts\setup-windows.ps1 first."
}

if (-not (Test-Path (Join-Path $Orch "node_modules"))) {
  Write-Host "Installing npm dependencies…"
  npm --prefix $Orch install
}

Write-Host "==> Flashwork desktop (dev)"
Set-Location $Root
npm run dev
