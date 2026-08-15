/// <reference types="vite/client" />

import type { FlashworkApi } from '../shared/flashwork-api';

declare global {
  interface Window {
    flashwork?: FlashworkApi;
  }
}

export {};
