import { contextBridge } from 'electron';

export type FlashworkApi = {
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
};

const api: FlashworkApi = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('flashwork', api);
