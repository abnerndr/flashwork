import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { PTYMessage } from '@flashwork/shared-types';

import type { FlashworkApi } from '../shared/flashwork-api';

const PTY_IPC = {
  message: 'pty:message',
  event: 'pty:event',
  list: 'pty:list',
  scrollback: 'pty:scrollback',
} as const;

export type { FlashworkApi } from '../shared/flashwork-api';

const api: FlashworkApi = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  pty: {
    send: (message) => ipcRenderer.invoke(PTY_IPC.message, message),
    list: () => ipcRenderer.invoke(PTY_IPC.list),
    scrollback: (sessionId) => ipcRenderer.invoke(PTY_IPC.scrollback, sessionId),
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, message: PTYMessage) => {
        listener(message);
      };
      ipcRenderer.on(PTY_IPC.event, handler);
      return () => {
        ipcRenderer.removeListener(PTY_IPC.event, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('flashwork', api);
