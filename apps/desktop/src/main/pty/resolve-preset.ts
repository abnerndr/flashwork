import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { TerminalCommandPreset } from '@flashwork/shared-types';

export type ResolvedPreset = {
  preset: TerminalCommandPreset;
  command: string;
  args: string[];
};

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookupOnPath(binary: string): string | null {
  if (isAbsolute(binary) && isExecutable(binary)) {
    return binary;
  }

  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolves allowlisted presets to real executable paths on the main process.
 * Renderer must never supply arbitrary command strings.
 */
export function resolveCommandPreset(preset: TerminalCommandPreset): ResolvedPreset {
  switch (preset) {
    case 'bash': {
      const shell = process.env.SHELL;
      const candidates = [
        shell && shell.includes('bash') ? shell : null,
        '/bin/bash',
        '/usr/bin/bash',
        'bash',
      ].filter((value): value is string => Boolean(value));

      for (const candidate of candidates) {
        const resolved = lookupOnPath(candidate) ?? (isAbsolute(candidate) && isExecutable(candidate) ? candidate : null);
        if (resolved) {
          return { preset, command: resolved, args: [] };
        }
      }
      throw new Error('Preset "bash" could not be resolved on PATH');
    }
    case 'claude': {
      const resolved = lookupOnPath('claude');
      if (!resolved) {
        throw new Error('Preset "claude" not found on PATH');
      }
      return { preset, command: resolved, args: [] };
    }
    case 'codex': {
      const resolved = lookupOnPath('codex');
      if (!resolved) {
        throw new Error('Preset "codex" not found on PATH');
      }
      return { preset, command: resolved, args: [] };
    }
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown preset: ${String(_exhaustive)}`);
    }
  }
}
