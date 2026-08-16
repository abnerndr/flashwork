import type { Floor, PTYMessage, TerminalCommandPreset } from '@flashwork/shared-types';

export type PtySessionInfo = {
  sessionId: string;
  pid: number;
  command: string;
  args: string[];
  cwd?: string;
};

export type CreateFloorInput = {
  name?: string;
  branch?: string;
  baseRef?: string;
};

export type FlashworkApi = {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  app: {
    createWindow: () => Promise<{ ok: true }>;
  };
  pty: {
    send: (message: PTYMessage) => Promise<unknown>;
    list: () => Promise<PtySessionInfo[]>;
    scrollback: (sessionId: string) => Promise<string>;
    onEvent: (listener: (message: PTYMessage) => void) => () => void;
  };
  floors: {
    create: (input?: CreateFloorInput) => Promise<Floor>;
    list: () => Promise<Floor[]>;
    remove: (floorId: string) => Promise<{ ok: true }>;
  };
};

export type { TerminalCommandPreset };
