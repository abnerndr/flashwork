# Flashwork — open the desktop app (Tauri + Vite) on native Windows.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js >= 22 is required. Run .\scripts\setup-windows.ps1 first."
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host "pnpm missing — running deps-only setup…"
  & node "$Root\scripts\setup.mjs" --deps-only
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
  Write-Error "Rust is required. Run .\scripts\setup-windows.ps1 first."
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  Write-Host "Installing pnpm dependencies…"
  Set-Location $Root
  pnpm install
}

Write-Host "==> Flashwork desktop (dev)"
Set-Location $Root
pnpm run app
