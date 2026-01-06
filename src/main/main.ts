import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { setupDatabase } from './database';

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Drifting',
    // 自定义窗口栏配置
    titleBarStyle: 'hiddenInset', // macOS: 隐藏标题栏但保留交通灯按钮
    // titleBarStyle: 'hidden', // 完全隐藏标题栏（包括交通灯）
    trafficLightPosition: { x: 12, y: 12 }, // macOS 交通灯按钮位置
    frame: process.platform !== 'darwin', // 非 macOS 显示边框
    // frame: false, // 如果要在所有平台完全无边框，取消注释这行
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: false,
  });

  // Show window when ready to prevent flickering
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Load the app
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // Open DevTools in development
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
  // Setup database IPC handlers
  setupDatabase();
  
  createWindow();

  app.on('activate', () => {
    // On macOS it's common to re-create a window when the dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle app updates and other IPC events
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle('app:getPath', (_event, name: 'home' | 'appData' | 'userData' | 'temp' | 'documents') => {
  return app.getPath(name);
});

// Window control handlers
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.handle('window:toggleMaximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow?.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});

ipcMain.handle('window:close', () => {
  mainWindow?.close();
});

ipcMain.handle('window:isMaximized', () => {
  return mainWindow?.isMaximized() ?? false;
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
