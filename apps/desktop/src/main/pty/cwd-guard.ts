import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function normalizeRoot(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return resolve(root);
  }
}

function isPathInside(target: string, root: string): boolean {
  const normalizedTarget = normalizeRoot(target);
  const normalizedRoot = normalizeRoot(root);
  if (normalizedTarget === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget.startsWith(prefix);
}

/**
 * Validates that cwd is under an allowed root (process.cwd() and/or floors root).
 * Returns the resolved absolute path, or throws.
 */
export function assertAllowedCwd(
  cwd: string | undefined,
  allowedRoots: readonly string[],
): string | undefined {
  if (!cwd) return undefined;

  const resolved = resolve(cwd);
  const ok = allowedRoots.some((root) => isPathInside(resolved, root));
  if (!ok) {
    throw new Error(
      `cwd is outside allowed roots: ${resolved} (allowed: ${allowedRoots.join(', ')})`,
    );
  }
  return resolved;
}
