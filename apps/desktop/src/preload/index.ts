import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Floor, PTYMessage } from '@flashwork/shared-types';

import type { CreateFloorInput, FlashworkApi } from '../shared/flashwork-api';

const PTY_IPC = {
  message: 'pty:message',
  event: 'pty:event',
  list: 'pty:list',
  scrollback: 'pty:scrollback',
} as const;

const FLOORS_IPC = {
  create: 'floors:create',
  list: 'floors:list',
  remove: 'floors:remove',
} as const;

const APP_IPC = {
  createWindow: 'app:create-window',
} as const;

export type { FlashworkApi } from '../shared/flashwork-api';

const api: FlashworkApi = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  app: {
    createWindow: () => ipcRenderer.invoke(APP_IPC.createWindow),
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
  floors: {
    create: (input?: CreateFloorInput) => ipcRenderer.invoke(FLOORS_IPC.create, input ?? {}),
    list: () => ipcRenderer.invoke(FLOORS_IPC.list) as Promise<Floor[]>,
    remove: (floorId) => ipcRenderer.invoke(FLOORS_IPC.remove, { floorId }),
  },
};

contextBridge.exposeInMainWorld('flashwork', api);
