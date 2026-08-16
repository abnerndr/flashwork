import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertAllowedCwd } from '../../main/pty/cwd-guard';

describe('assertAllowedCwd', () => {
  it('allows paths under configured roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fw-cwd-'));
    const nested = join(root, 'floors', 'a');
    await mkdir(nested, { recursive: true });

    expect(assertAllowedCwd(nested, [root])).toBe(nested);
    expect(assertAllowedCwd(undefined, [root])).toBeUndefined();
  });

  it('rejects paths outside allowed roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fw-cwd-'));
    expect(() => assertAllowedCwd('/tmp/outside-flashwork', [root])).toThrow(/outside allowed roots/);
  });
});
