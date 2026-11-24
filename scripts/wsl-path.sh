#!/usr/bin/env bash
# Flashwork — path bridge helpers between Windows and WSL.
#
# Prefer forward slashes when calling from PowerShell (backslashes get eaten):
#   ./scripts/wsl-path.sh to-linux 'C:/Users/abner/proj'
#   ./scripts/wsl-path.sh to-unc /home/abner/proj Ubuntu-24.04
#   ./scripts/wsl-path.sh detect-distro
set -euo pipefail

usage() {
  echo "usage: $0 {to-linux|to-unc|detect-distro} [args…]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
cmd="$1"
shift

normalize_seps() {
  # Turn any mix of \ and / into /
  local s="$1"
  s="${s//\\//}"
  printf '%s' "$s"
}

case "$cmd" in
  detect-distro)
    if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
      echo "$WSL_DISTRO_NAME"
      exit 0
    fi
    if command -v wsl.exe >/dev/null 2>&1; then
      mapfile -t names < <(wsl.exe -l -q 2>/dev/null | tr -d '\0\r' | sed '/^$/d')
      for name in "${names[@]+"${names[@]}"}"; do
        case "${name,,}" in
          docker-desktop|docker-desktop-data|docker-desktop*) continue ;;
        esac
        echo "$name"
        exit 0
      done
    fi
    echo "Ubuntu-24.04"
    ;;

  to-linux)
    [[ $# -ge 1 ]] || usage
    path="$(normalize_seps "$1")"
    # UNC //wsl.localhost/Distro/home/… or //wsl$/…
    if [[ "$path" =~ ^//(wsl\.localhost|wsl\$)/([^/]+)/?(.*)$ ]]; then
      rest="${BASH_REMATCH[3]}"
      echo "/${rest}"
      exit 0
    fi
    # Drive letter C:/… or C:…
    if [[ "$path" =~ ^[A-Za-z]:/?(.*)$ ]]; then
      drive="$(printf '%s' "${path:0:1}" | tr '[:upper:]' '[:lower:]')"
      rest="${BASH_REMATCH[1]}"
      if [[ -z "$rest" ]]; then
        echo "/mnt/${drive}"
      else
        echo "/mnt/${drive}/${rest}"
      fi
      exit 0
    fi
    echo "$path"
    ;;

  to-unc)
    [[ $# -ge 1 ]] || usage
    linux="$(normalize_seps "$1")"
    distro="${2:-${WSL_DISTRO_NAME:-}}"
    if [[ -z "$distro" ]]; then
      distro="$("$0" detect-distro)"
    fi
    trimmed="${linux#/}"
    trimmed="${trimmed%/}"
    if [[ -z "$trimmed" ]]; then
      printf '%s\n' "\\\\wsl.localhost\\${distro}"
    else
      win="${trimmed//\//\\}"
      printf '%s\n' "\\\\wsl.localhost\\${distro}\\${win}"
    fi
    ;;

  *)
    usage
    ;;
esac
