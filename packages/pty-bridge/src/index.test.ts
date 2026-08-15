import { describe, expect, it, vi } from 'vitest';

import { PtySessionManager, type PtyLike, type PtySpawner } from './index.js';

function createFakePty(): PtyLike & {
  emitData: (chunk: string) => void;
  emitExit: (exitCode: number) => void;
} {
  let dataHandler: ((data: string) => void) | undefined;
  let exitHandler: ((e: { exitCode: number; signal?: number }) => void) | undefined;

  return {
    pid: 4242,
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData(cb) {
      dataHandler = cb;
      return { dispose: () => undefined };
    },
    onExit(cb) {
      exitHandler = cb;
      return { dispose: () => undefined };
    },
    emitData(chunk) {
      dataHandler?.(chunk);
    },
    emitExit(exitCode) {
      exitHandler?.({ exitCode });
    },
  };
}

describe('PtySessionManager', () => {
  it('spawns, writes, resizes, and kills a session', () => {
    const fake = createFakePty();
    const spawner: PtySpawner = vi.fn(() => fake);
    const manager = new PtySessionManager({ spawner, scrollbackLimit: 100 });

    const spawned = manager.spawn({
      sessionId: 's1',
      command: '/bin/bash',
      args: ['-l'],
      cols: 100,
      rows: 30,
      cwd: '/tmp',
    });

    expect(spawned).toEqual({ sessionId: 's1', pid: 4242 });
    expect(spawner).toHaveBeenCalledWith(
      '/bin/bash',
      ['-l'],
      expect.objectContaining({
        cols: 100,
        rows: 30,
        cwd: '/tmp',
      }),
    );

    manager.write('s1', 'echo hi\n');
    expect(fake.write).toHaveBeenCalledWith('echo hi\n');

    manager.resize('s1', 120, 40);
    expect(fake.resize).toHaveBeenCalledWith(120, 40);

    expect(manager.has('s1')).toBe(true);
    expect(manager.list()).toEqual([
      expect.objectContaining({ sessionId: 's1', pid: 4242, command: '/bin/bash' }),
    ]);

    manager.kill('s1');
    expect(fake.kill).toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
  });

  it('forwards data/exit and keeps scrollback for reconnect', () => {
    const fake = createFakePty();
    const manager = new PtySessionManager({
      spawner: () => fake,
      scrollbackLimit: 10,
    });

    const onData = vi.fn();
    const onExit = vi.fn();
    manager.subscribeData(onData);
    manager.subscribeExit(onExit);

    manager.spawn({ sessionId: 's2', command: 'bash' });
    fake.emitData('hello-world');
    expect(onData).toHaveBeenCalledWith('s2', 'hello-world');
    expect(manager.getScrollback('s2')).toBe('ello-world');

    fake.emitExit(0);
    expect(onExit).toHaveBeenCalledWith('s2', 0);
    expect(manager.has('s2')).toBe(false);
  });

  it('rejects duplicate session ids and unknown sessions', () => {
    const manager = new PtySessionManager({
      spawner: () => createFakePty(),
    });

    manager.spawn({ sessionId: 'dup', command: 'bash' });
    expect(() => manager.spawn({ sessionId: 'dup', command: 'bash' })).toThrow(/already exists/i);
    expect(() => manager.write('missing', 'x')).toThrow(/unknown session/i);
  });
});
