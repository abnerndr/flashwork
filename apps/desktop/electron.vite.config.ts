import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Bundle workspace packages into main/preload so CJS output can use ESM-only deps safely.
// Keep native PTY binding external.
const externalize = externalizeDepsPlugin({
  exclude: ['@flashwork/shared-types', '@flashwork/pty-bridge'],
});

export default defineConfig({
  main: {
    plugins: [externalize],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
        external: ['@homebridge/node-pty-prebuilt-multiarch'],
      },
    },
  },
  preload: {
    plugins: [externalize],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    plugins: [react()],
  },
});
