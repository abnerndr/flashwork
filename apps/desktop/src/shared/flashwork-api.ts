import type { PTYMessage } from '@flashwork/shared-types';

export type PtySessionInfo = {
  sessionId: string;
  pid: number;
  command: string;
  args: string[];
  cwd?: string;
};

export type FlashworkApi = {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  pty: {
    send: (message: PTYMessage) => Promise<unknown>;
    list: () => Promise<PtySessionInfo[]>;
    scrollback: (sessionId: string) => Promise<string>;
    onEvent: (listener: (message: PTYMessage) => void) => () => void;
  };
};
