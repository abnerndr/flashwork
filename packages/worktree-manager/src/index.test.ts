import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from './index.js';

async function initTempRepo(): Promise<{ repoRoot: string; worktreesDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fw-wt-'));
  const repoRoot = join(root, 'repo');
  const worktreesDir = join(root, 'worktrees');

  execFileSync('git', ['init', '-b', 'main', repoRoot], { encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@flashwork.local'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Flashwork Test'], { cwd: repoRoot });
  await writeFile(join(repoRoot, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  return { repoRoot, worktreesDir };
}

const managers: WorktreeManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    const listed = await manager.list().catch(() => []);
    for (const entry of listed) {
      if (entry.path === manager.getRepoRoot()) continue;
      await manager.remove(entry.path).catch(() => undefined);
    }
  }
});

describe('WorktreeManager', () => {
  it('creates, lists, and removes worktrees', async () => {
    const { repoRoot, worktreesDir } = await initTempRepo();
    const manager = new WorktreeManager({ repoRoot, worktreesDir });
    managers.push(manager);

    const created = await manager.create({
      branch: 'floor/agent-a',
      name: 'agent-a',
    });

    expect(created.branch).toBe('floor/agent-a');
    expect(created.path.startsWith(worktreesDir)).toBe(true);

    const listed = await manager.list();
    expect(listed.some((item) => item.path === created.path)).toBe(true);

    await manager.remove(created.path);
    const after = await manager.list();
    expect(after.some((item) => item.path === created.path)).toBe(false);
  });

  it('gives different floors distinct worktree paths (2.6)', async () => {
    const { repoRoot, worktreesDir } = await initTempRepo();
    const manager = new WorktreeManager({ repoRoot, worktreesDir });
    managers.push(manager);

    const floorA = await manager.create({ branch: 'floor/a', name: 'floor-a' });
    const floorB = await manager.create({ branch: 'floor/b', name: 'floor-b' });

    expect(floorA.path).not.toBe(floorB.path);
    expect(floorA.branch).not.toBe(floorB.branch);

    // File written in A must not appear in B (isolation proof).
    await writeFile(join(floorA.path, 'secret-a.txt'), 'only-a');
    await expect(
      writeFile(join(floorB.path, 'probe.txt'), 'b'),
    ).resolves.toBeUndefined();

    const { readFile } = await import('node:fs/promises');
    await expect(readFile(join(floorA.path, 'secret-a.txt'), 'utf8')).resolves.toBe('only-a');
    await expect(readFile(join(floorB.path, 'secret-a.txt'), 'utf8')).rejects.toThrow();
  });
});
