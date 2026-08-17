# Flashwork — check/install host deps on native Windows (PowerShell).
# Run from repo root:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Orch = Join-Path $Root "apps\orchestrator"

Write-Host "==> Flashwork setup (Windows nativo)"
Write-Host "    repo: $Root"

function Test-Cmd($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

if (-not (Test-Cmd "node")) {
  Write-Error "Node.js >= 22 is required. Install: https://nodejs.org"
}
$major = [int]((node -v).TrimStart("v").Split(".")[0])
if ($major -lt 22) {
  Write-Error "Node.js >= 22 required (found $(node -v))."
}

if (-not (Test-Cmd "rustc")) {
  Write-Host "Rust not found. Install rustup from https://rustup.rs then re-open this terminal."
  Write-Error "Rust is required for the Tauri app."
}

Write-Host @"
Also required on Windows (install once if missing):
  - Visual Studio Build Tools — workload "Desktop development with C++"
  - WebView2 Runtime (usually already on Windows 11)
    https://developer.microsoft.com/microsoft-edge/webview2/
"@

Write-Host "==> npm install (apps/orchestrator)"
Push-Location $Orch
try {
  npm install
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "OK. Next:"
Write-Host "  .\scripts\dev.ps1"
Write-Host "  or:  npm run dev"
