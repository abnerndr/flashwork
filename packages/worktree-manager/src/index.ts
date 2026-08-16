import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

export type WorktreeInfo = {
  id: string;
  path: string;
  branch: string;
  bare: boolean;
};

export type WorktreeManagerOptions = {
  /** Absolute path to the main git repository. */
  repoRoot: string;
  /** Directory where new worktrees are created. */
  worktreesDir: string;
};

export type CreateWorktreeInput = {
  /** Branch name to create/checkout in the new worktree. */
  branch: string;
  /** Optional directory name under worktreesDir (defaults to sanitized branch). */
  name?: string;
  /** Base ref for new branches (default: HEAD). */
  baseRef?: string;
};

async function git(
  repoRoot: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function sanitizeDirName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'floor';
}

function parseWorktreeList(stdout: string): WorktreeInfo[] {
  const blocks = stdout.trim().split(/\n\n+/).filter(Boolean);
  const result: WorktreeInfo[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let path = '';
    let branch = '';
    let bare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.replace(/^refs\/heads\//, '');
      } else if (line === 'bare') {
        bare = true;
      } else if (line.startsWith('detached')) {
        branch = '(detached)';
      }
    }

    if (!path) continue;
    result.push({
      id: basename(path),
      path,
      branch: branch || '(unknown)',
      bare,
    });
  }

  return result;
}

export class WorktreeManager {
  private readonly repoRoot: string;
  private readonly worktreesDir: string;

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.worktreesDir = resolve(options.worktreesDir);
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.worktreesDir, { recursive: true });
    await git(this.repoRoot, ['rev-parse', '--is-inside-work-tree']);
  }

  async create(input: CreateWorktreeInput): Promise<WorktreeInfo> {
    await this.ensureReady();

    const dirName = sanitizeDirName(input.name ?? input.branch);
    const uniqueSuffix = randomUUID().slice(0, 8);
    const targetPath = join(this.worktreesDir, `${dirName}-${uniqueSuffix}`);
    const baseRef = input.baseRef ?? 'HEAD';

    // Create a new branch from baseRef at the new worktree path.
    await git(this.repoRoot, [
      'worktree',
      'add',
      '-b',
      input.branch,
      targetPath,
      baseRef,
    ]);

    return {
      id: basename(targetPath),
      path: targetPath,
      branch: input.branch,
      bare: false,
    };
  }

  async list(): Promise<WorktreeInfo[]> {
    await this.ensureReady();
    const { stdout } = await git(this.repoRoot, ['worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout);
  }

  /**
   * Removes a worktree by absolute path (or id under worktreesDir).
   * Also attempts to delete the associated local branch when it is not checked out elsewhere.
   */
  async remove(pathOrId: string, options?: { deleteBranch?: boolean }): Promise<void> {
    await this.ensureReady();

    const targetPath = pathOrId.includes('/') || pathOrId.includes('\\')
      ? resolve(pathOrId)
      : join(this.worktreesDir, pathOrId);

    const listed = await this.list();
    const entry = listed.find((item) => item.path === targetPath);
    if (!entry) {
      throw new Error(`Worktree not found: ${targetPath}`);
    }
    if (resolve(entry.path) === this.repoRoot) {
      throw new Error('Refusing to remove the main repository worktree');
    }

    await git(this.repoRoot, ['worktree', 'remove', '--force', targetPath]);
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);

    if (options?.deleteBranch !== false && entry.branch && !entry.branch.startsWith('(')) {
      try {
        await git(this.repoRoot, ['branch', '-D', entry.branch]);
      } catch {
        // Branch may still be in use or already deleted — ignore.
      }
    }

    await git(this.repoRoot, ['worktree', 'prune']).catch(() => undefined);
  }

  getWorktreesDir(): string {
    return this.worktreesDir;
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }
}
