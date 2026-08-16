import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'node:path';

import { registerFloorsIpc } from './ipc/floors';
import { registerPtyIpc } from './ipc/pty';

export const APP_IPC = {
  createWindow: 'app:create-window',
} as const;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Flashwork',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

function ensureWindow(): BrowserWindow {
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  return createWindow();
}

function setupApplicationMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Arquivo',
      submenu: [
        {
          label: 'Nova janela',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            createWindow();
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Janela',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        {
          label: 'Nova janela',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            createWindow();
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerAppIpc(): void {
  ipcMain.handle(APP_IPC.createWindow, () => {
    createWindow();
    return { ok: true as const };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    ensureWindow();
  });

  app.whenReady().then(() => {
    registerPtyIpc();
    registerFloorsIpc();
    registerAppIpc();
    setupApplicationMenu();
    createWindow();

    // macOS dock click + non-macOS reactivation path when no windows remain.
    app.on('activate', () => {
      ensureWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Keep the main process alive so PTY sessions survive window close (PRD 1.6).
    // Reopen via: menu "Nova janela", Ctrl/Cmd+Shift+N, app:create-window IPC,
    // second-instance focus, or platform activate (dock / taskbar).
    if (process.platform !== 'darwin') {
      // Intentionally do not call app.quit() during MVP shell.
    }
  });
}
