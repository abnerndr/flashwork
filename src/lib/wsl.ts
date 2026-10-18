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

/** `/home/u/proj` in `Ubuntu` → `\\wsl.localhost\Ubuntu\home\u\proj`. */
export function linuxPathToWslUnc(distro: string, linuxPath: string): string {
  const trimmed = linuxPath.trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `\\\\wsl.localhost\\${distro}\\${trimmed.replace(/\//g, '\\')}` : `\\\\wsl.localhost\\${distro}`
}

/**
 * Folder to store for a project. With a distro chosen, a Linux path (`/home/u/p`)
 * becomes its UNC spelling; anything else (UNC, Windows path) is kept as typed.
 */
export function resolveProjectFolder(folder: string, distro: string | undefined): string {
  const trimmed = folder.trim()
  if (distro && trimmed.startsWith('/')) return linuxPathToWslUnc(distro, trimmed)
  return trimmed
}
