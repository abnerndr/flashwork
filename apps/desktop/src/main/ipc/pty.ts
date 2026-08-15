import { BrowserWindow, ipcMain } from 'electron';
import {
  PTYMessageSchema,
  type PTYMessage,
} from '@flashwork/shared-types';
import { PtySessionManager } from '@flashwork/pty-bridge';
import * as nativePty from '@homebridge/node-pty-prebuilt-multiarch';

export const PTY_IPC = {
  message: 'pty:message',
  event: 'pty:event',
  list: 'pty:list',
  scrollback: 'pty:scrollback',
} as const;

const manager = new PtySessionManager({
  spawner: (file, args, options) => nativePty.spawn(file, args, options),
});

function broadcast(message: PTYMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(PTY_IPC.event, message);
    }
  }
}

export function getPtyManager(): PtySessionManager {
  return manager;
}

export function registerPtyIpc(): void {
  manager.subscribeData((sessionId, data) => {
    broadcast({ type: 'data', sessionId, data });
  });

  manager.subscribeExit((sessionId, exitCode) => {
    broadcast({ type: 'exit', sessionId, exitCode });
  });

  ipcMain.handle(PTY_IPC.message, (_event, raw: unknown) => {
    const message = PTYMessageSchema.parse(raw);

    switch (message.type) {
      case 'spawn': {
        const result = manager.spawn({
          sessionId: message.sessionId,
          command: message.command,
          args: message.args,
          cwd: message.cwd,
          cols: message.cols,
          rows: message.rows,
          env: message.env,
        });
        return result;
      }
      case 'write': {
        manager.write(message.sessionId, message.data);
        return { ok: true as const };
      }
      case 'resize': {
        manager.resize(message.sessionId, message.cols, message.rows);
        return { ok: true as const };
      }
      case 'kill': {
        if (manager.has(message.sessionId)) {
          manager.kill(message.sessionId);
        }
        return { ok: true as const };
      }
      case 'data':
      case 'exit':
        throw new Error(`Renderer cannot send PTY event type: ${message.type}`);
      default: {
        const _exhaustive: never = message;
        throw new Error(`Unhandled PTY message: ${JSON.stringify(_exhaustive)}`);
      }
    }
  });

  ipcMain.handle(PTY_IPC.list, () => manager.list());

  ipcMain.handle(PTY_IPC.scrollback, (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('sessionId must be a non-empty string');
    }
    return manager.getScrollback(sessionId);
  });
}
