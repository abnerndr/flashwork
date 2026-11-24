# Flashwork — remove Desktop + Start Menu WSL launch shortcuts.
#   powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows-wsl-shortcut.ps1
$ErrorActionPreference = "Stop"

$paths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Flashwork.lnk"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Flashwork.lnk")
)

foreach ($path in $paths) {
  if (Test-Path $path) {
    Remove-Item -Force $path
    Write-Host "Removed: $path"
  } else {
    Write-Host "Absent:  $path"
  }
}

Write-Host "OK."
