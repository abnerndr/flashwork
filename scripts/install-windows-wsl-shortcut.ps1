# Flashwork — create Desktop + Start Menu shortcuts that launch via WSL.
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-wsl-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-wsl-shortcut.ps1 -Distro Ubuntu-24.04
#
# The shortcut must NOT point at a broken Windows-native path into the Linux FS.
# It runs: wsl.exe -d <Distro> -- bash <linuxRepo>/scripts/flashwork-wsl.sh

[CmdletBinding()]
param(
  [string]$Distro = "",
  [string]$LinuxRepo = "",
  [switch]$SkipStartMenu,
  [switch]$SkipDesktop
)

$ErrorActionPreference = "Stop"

function Get-WslUtf8Lines([string[]]$WslArgs) {
  $prev = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    $raw = & wsl.exe @WslArgs 2>$null
  } finally {
    [Console]::OutputEncoding = $prev
  }
  if ($null -eq $raw) { return @() }
  return @($raw | ForEach-Object {
    ($_ -replace "`0", "").Trim()
  } | Where-Object { $_ -ne "" })
}

function Resolve-FlashworkDistro([string]$Preferred) {
  if ($Preferred) { return $Preferred }
  if ($env:FLASHWORK_WSL_DISTRO) { return $env:FLASHWORK_WSL_DISTRO }

  $names = Get-WslUtf8Lines @("-l", "-q")
  $usable = @($names | Where-Object {
    $_ -notmatch '^(docker-desktop|docker-desktop-data)$'
  })
  if ($usable.Count -eq 0) {
    throw "No usable WSL distro found. Install Ubuntu-24.04 (or set -Distro / FLASHWORK_WSL_DISTRO)."
  }
  # Prefer Ubuntu-24.04 when present.
  $ubuntu = $usable | Where-Object { $_ -eq "Ubuntu-24.04" } | Select-Object -First 1
  if ($ubuntu) { return $ubuntu }
  return $usable[0]
}

function Test-LinuxRepo([string]$DistroName, [string]$LinuxPath) {
  # Avoid login-shell noise; keep the check as a single argv for wsl.exe.
  $script = "test -f `"$LinuxPath/scripts/flashwork-wsl.sh`" && printf OK"
  $prev = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $raw = & wsl.exe -d $DistroName -- bash -c $script 2>$null
  } finally {
    [Console]::OutputEncoding = $prev
  }
  $joined = if ($null -eq $raw) { "" } else { (@($raw) -join "").Replace("`0", "").Trim() }
  return $joined -match 'OK'
}

function Resolve-LinuxRepo([string]$DistroName, [string]$Override) {
  if ($Override) {
    $path = ($Override -replace '\\', '/').TrimEnd('/')
    if (-not (Test-LinuxRepo $DistroName $path)) {
      throw "LinuxRepo '$path' has no scripts/flashwork-wsl.sh inside distro '$DistroName'."
    }
    return $path
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  # Map this checkout's UNC path (\\wsl.localhost\Distro\home\…) into Linux.
  $winScriptDir = Split-Path -Parent $PSCommandPath
  $winRepo = (Resolve-Path (Split-Path -Parent $winScriptDir)).Path
  if ($winRepo -match '(?i)(?:\\\\|\wsl\.localhost\\)(?:wsl(?:\.localhost|\$)\\)?([^\\]+)\\(.+)$' `
    -or $winRepo -match '(?i)^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.+)$') {
    $linuxTail = "/" + ($Matches[2] -replace '\\', '/')
    $candidates.Add($linuxTail.TrimEnd('/')) | Out-Null
  }

  $candidates.Add("/home/abner/www/abnerndr/flashwork") | Out-Null
  $home = (Get-WslUtf8Lines @("-d", $DistroName, "--", "bash", "-c", "printf %s `$HOME")) | Select-Object -First 1
  if ($home) {
    $candidates.Add("$home/www/abnerndr/flashwork") | Out-Null
    $candidates.Add("$home/flashwork") | Out-Null
  }

  foreach ($path in ($candidates | Select-Object -Unique)) {
    if (Test-LinuxRepo $DistroName $path) { return $path }
  }

  throw "Could not locate Flashwork inside distro '$DistroName'. Pass -LinuxRepo /home/…/flashwork"
}

function New-FlashworkShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$ShortcutPath,
    [Parameter(Mandatory = $true)][string]$DistroName,
    [Parameter(Mandatory = $true)][string]$RepoLinux,
    [string]$IconPath = ""
  )

  $dir = Split-Path -Parent $ShortcutPath
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  # Use bash (not login) — flashwork-wsl.sh sources lib.sh and loads nvm itself.
  $launch = "bash `"$RepoLinux/scripts/flashwork-wsl.sh`""
  $arguments = "-d `"$DistroName`" --cd `"$RepoLinux`" -- $launch"

  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($ShortcutPath)
  $sc.TargetPath = "wsl.exe"
  $sc.Arguments = $arguments
  $sc.WorkingDirectory = "%USERPROFILE%"
  $sc.WindowStyle = 1
  $sc.Description = "Flashwork (via WSL $DistroName)"
  if ($IconPath -and (Test-Path $IconPath)) {
    $sc.IconLocation = $IconPath
  }
  $sc.Save()
  Write-Host "Created: $ShortcutPath"
  Write-Host "  → wsl.exe $arguments"
}

$resolvedDistro = Resolve-FlashworkDistro $Distro
$resolvedRepo = Resolve-LinuxRepo $resolvedDistro $LinuxRepo

Write-Host "==> Flashwork Windows→WSL shortcut"
Write-Host "    Distro: $resolvedDistro"
Write-Host "    Repo:   $resolvedRepo"

# Optional icon from the Linux FS UNC (best-effort).
$iconUnc = "\\wsl.localhost\$resolvedDistro$($resolvedRepo -replace '/','\')\src-tauri\icons\icon.ico"
if (-not (Test-Path $iconUnc)) {
  $iconUnc = ""
}

if (-not $SkipDesktop) {
  $desktop = [Environment]::GetFolderPath("Desktop")
  New-FlashworkShortcut -ShortcutPath (Join-Path $desktop "Flashwork.lnk") `
    -DistroName $resolvedDistro -RepoLinux $resolvedRepo -IconPath $iconUnc
}

if (-not $SkipStartMenu) {
  $start = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  New-FlashworkShortcut -ShortcutPath (Join-Path $start "Flashwork.lnk") `
    -DistroName $resolvedDistro -RepoLinux $resolvedRepo -IconPath $iconUnc
}

Write-Host ""
Write-Host "OK. Double-click Flashwork on the Desktop or find it in the Start Menu."
Write-Host "Uninstall: powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows-wsl-shortcut.ps1"
