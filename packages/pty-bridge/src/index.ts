import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type PtyLike = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): { dispose: () => void } | void;
  onExit(
    callback: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose: () => void } | void;
};

export type PtySpawnOptions = {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
};

export type PtySpawner = (
  file: string,
  args: string[],
  options: PtySpawnOptions,
) => PtyLike;

export type PtySessionInfo = {
  sessionId: string;
  pid: number;
  command: string;
  args: string[];
  cwd?: string;
};

export type PtyManagerOptions = {
  spawner?: PtySpawner;
  scrollbackLimit?: number;
  env?: NodeJS.ProcessEnv;
};

export type SpawnSessionInput = {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
};

type InternalSession = {
  info: PtySessionInfo;
  pty: PtyLike;
  scrollback: string;
};

const DEFAULT_SCROLLBACK = 200_000;

function defaultSpawner(
  file: string,
  args: string[],
  options: PtySpawnOptions,
): PtyLike {
  // Lazy require keeps unit tests free of native bindings when a mock spawner is injected.
  const pty = require('@homebridge/node-pty-prebuilt-multiarch') as {
    spawn: PtySpawner;
  };
  return pty.spawn(file, args, options);
}

export class PtySessionManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly spawner: PtySpawner;
  private readonly scrollbackLimit: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly dataListeners = new Set<(sessionId: string, data: string) => void>();
  private readonly exitListeners = new Set<
    (sessionId: string, exitCode: number | null) => void
  >();

  constructor(options: PtyManagerOptions = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.scrollbackLimit = options.scrollbackLimit ?? DEFAULT_SCROLLBACK;
    this.baseEnv = options.env ?? process.env;
  }

  spawn(input: SpawnSessionInput): { sessionId: string; pid: number } {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`PTY session already exists: ${input.sessionId}`);
    }

    const args = input.args ?? [];
    const cols = input.cols ?? 80;
    const rows = input.rows ?? 24;
    const env = {
      ...this.baseEnv,
      ...input.env,
    } as Record<string, string>;

    const pty = this.spawner(input.command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: input.cwd,
      env,
    });

    const info: PtySessionInfo = {
      sessionId: input.sessionId,
      pid: pty.pid,
      command: input.command,
      args,
      cwd: input.cwd,
    };

    const session: InternalSession = {
      info,
      pty,
      scrollback: '',
    };
    this.sessions.set(input.sessionId, session);

    pty.onData((data) => {
      this.appendScrollback(session, data);
      for (const listener of this.dataListeners) {
        listener(input.sessionId, data);
      }
    });

    pty.onExit(({ exitCode }) => {
      this.sessions.delete(input.sessionId);
      for (const listener of this.exitListeners) {
        listener(input.sessionId, exitCode ?? null);
      }
    });

    return { sessionId: input.sessionId, pid: pty.pid };
  }

  write(sessionId: string, data: string): void {
    this.requireSession(sessionId).pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.requireSession(sessionId).pty.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.pty.kill();
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(): PtySessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  getScrollback(sessionId: string): string {
    return this.sessions.get(sessionId)?.scrollback ?? '';
  }

  subscribeData(listener: (sessionId: string, data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  subscribeExit(
    listener: (sessionId: string, exitCode: number | null) => void,
  ): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  private requireSession(sessionId: string): InternalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  private appendScrollback(session: InternalSession, chunk: string): void {
    session.scrollback = `${session.scrollback}${chunk}`.slice(-this.scrollbackLimit);
  }
}
