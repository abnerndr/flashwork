/**
 * WSL path helpers (mirror of `src-tauri/src/wsl.rs`). A project inside a WSL
 * distro is stored as a `\\wsl.localhost\<distro>\…` UNC path so every Windows
 * API and the Rust backend can derive the distro and the Linux path from it.
 */

export type WslPath = { distro: string; linuxPath: string }

/** Parses `\\wsl$\D\x`, `\\wsl.localhost\D\x`, `\\?\UNC\wsl.localhost\D\x` and `/` spellings. */
export function parseWslPath(path: string | undefined | null): WslPath | null {
  if (!path) return null
  const normalized = path.trim().replace(/\//g, '\\')
  let rest: string
  if (/^\\\\\?\\UNC\\/i.test(normalized)) rest = normalized.slice(8)
  else if (normalized.startsWith('\\\\')) rest = normalized.slice(2)
  else return null
  const [host, distro, ...parts] = rest.split('\\')
  if (!host || !/^(wsl\$|wsl\.localhost)$/i.test(host) || !distro) return null
  return { distro, linuxPath: `/${parts.filter(Boolean).join('/')}` }
}

export function wslDistroFromPath(path: string | undefined | null): string | undefined {
  return parseWslPath(path)?.distro
}

const UTILITY_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

function usableDistros(names: string[]): string[] {
  const usable = names.filter((name) => !UTILITY_DISTROS.has(name.toLowerCase()))
  return usable.length > 0 ? usable : names
}

/**
 * Distro to turn on at startup. A pinned choice, or a distribution already
 * selected, is left alone. Utility distros such as docker-desktop are ignored.
 */
export function wslPreferenceFromDetection(
  pinned: boolean,
  enabled: boolean,
  currentDistro: string,
  distros: string[],
  running: string[] = [],
): { wslEnabled: true; wslDefaultDistro: string } | null {
  if (pinned) return null
  if (enabled && currentDistro.trim()) return null
  const candidates = distros.filter((name) => !UTILITY_DISTROS.has(name.toLowerCase()))
  const distro = preferredWslDistro(candidates, running)
  if (!distro) return null
  return { wslEnabled: true, wslDefaultDistro: distro }
}

/** Records an explicit PowerShell / WSL choice so startup detection does not override it. */
export function explicitWslPreference(distro: string): {
  wslEnabled: boolean
  wslDefaultDistro: string
  wslEnvironmentPinned: boolean
} {
  return {
    wslEnabled: Boolean(distro),
    wslDefaultDistro: distro,
    wslEnvironmentPinned: true,
  }
}

/**
 * OS family whose installers and shells should run. On Windows, a selected WSL
 * distribution is the runtime, so CLIs are installed inside it.
 */
export function installTargetOs(
  host: 'windows' | 'macos' | 'linux',
  preferences: { wslEnabled: boolean; wslDefaultDistro: string },
): 'windows' | 'macos' | 'linux' {
  if (host === 'windows' && preferences.wslEnabled && preferences.wslDefaultDistro.trim()) {
    return 'linux'
  }
  return host
}

/** Prefer the current choice, then a running user distro, then any user distro. */
export function preferredWslDistro(
  distros: string[],
  running: string[] = [],
  current = '',
): string {
  if (current && distros.includes(current)) return current
  const installed = new Set(distros)
  const runningInstalled = running.filter((name) => installed.has(name))
  return usableDistros(runningInstalled)[0] ?? usableDistros(distros)[0] ?? ''
}

/** `My Project` → `~/my-project`, used when a WSL project has no folder yet. */
export function linuxHomeProjectFolder(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `~/${slug || 'project'}`
}

/** An empty folder with a distro selected becomes `~/name` inside that distro. */
export function folderForNewProject(
  folder: string,
  distro: string | undefined,
  name: string,
): string {
  const trimmed = folder.trim()
  if (trimmed || !distro) return trimmed
  return linuxHomeProjectFolder(name)
}

/** `/home/u/proj` in `Ubuntu` → `\\wsl.localhost\Ubuntu\home\u\proj`. */
export function linuxPathToWslUnc(distro: string, linuxPath: string): string {
  const trimmed = linuxPath.trim().replace(/^\/+|\/+$/g, '')
  return trimmed
    ? `\\\\wsl.localhost\\${distro}\\${trimmed.replace(/\//g, '\\')}`
    : `\\\\wsl.localhost\\${distro}`
}

/**
 * Folder to store for a project. With a distro chosen, a Linux path (`/home/u/p`)
 * becomes its UNC spelling; Windows and UNC host paths stay intact.
 */
export function resolveProjectFolder(folder: string, distro: string | undefined): string {
  const trimmed = folder.trim()
  if (parseWslPath(trimmed)) return trimmed
  if (distro && trimmed.startsWith('/')) return linuxPathToWslUnc(distro, trimmed)
  return trimmed
}
