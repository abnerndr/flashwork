function normalizeSlashes(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

function isWindowsAbs(path: string): boolean {
  return /^[a-zA-Z]:\//.test(path) || path.startsWith('//')
}

/** Repo-relative POSIX path, or null when `absPath` is outside `root` or escapes via `..`. */
export function workspaceRelFromAbs(root: string, absPath: string): string | null {
  const rootNorm = normalizeSlashes(root)
  const absNorm = normalizeSlashes(absPath)
  if (!rootNorm || !absNorm) return null

  const win = isWindowsAbs(rootNorm) || isWindowsAbs(absNorm)
  const rootCmp = win ? rootNorm.toLowerCase() : rootNorm
  const absCmp = win ? absNorm.toLowerCase() : absNorm
  const prefix = `${rootCmp}/`
  if (!absCmp.startsWith(prefix)) return null

  const rel = absNorm.slice(rootNorm.length).replace(/^\/+/, '')
  if (!rel) return null
  if (rel.split('/').some((segment) => segment === '..')) return null
  return rel
}

export function isAbsoluteFsPath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, '/')
  return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)
}
