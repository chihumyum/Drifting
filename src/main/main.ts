import { app, BrowserWindow, ipcMain, screen, shell, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { setupDatabase } from './database';

// Handle creating/removing shortcuts on Windows when installing/uninstalling
if (started) {
  app.quit();
}

// Register as default handler for drifting:// deep links
// Must be called before app.whenReady()
app.setAsDefaultProtocolClient('drifting');

// macOS: handle deep link when app is already running
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

async function handleDeepLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
      const token = parsed.searchParams.get('token');
      const error = parsed.searchParams.get('error');

      // Set the session cookie in Electron's networking stack so authClient
      // requests to localhost:3000 will automatically include it.
      // MUST be awaited before sending the IPC message — the renderer calls
      // checkSession() immediately on receipt, and the fetch needs the cookie.
      if (token) {
        const apiOrigin = process.env.API_BASE_URL ?? 'http://localhost:3000';
        try {
          await session.defaultSession.cookies.set({
            url: apiOrigin,
            name: 'better-auth.session_token',
            value: token,
            httpOnly: true,
            secure: false,
            sameSite: 'lax',
            expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
          });
        } catch (err) {
          console.error('[OAuth] Failed to set session cookie:', err);
        }
      }

      mainWindow?.webContents.send('auth:oauth-callback', { token, error });
    }
  } catch (err) {
    console.error('[OAuth] Failed to parse deep link:', err);
  }
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: screen.getPrimaryDisplay().workAreaSize.width,
    height: screen.getPrimaryDisplay().workAreaSize.height,
    minWidth: 1000,
    minHeight: 700,
    title: 'Drifting',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false, // 开发环境禁用 web security 以避免 CORS 问题
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

// OAuth: open system browser for social login, then wait for deep-link callback.
// We open the /oauth-redirect/:provider endpoint directly in the external browser
// so that the OAuth state cookie is set in the browser's own cookie jar.
// If we instead fetched the sign-in URL from the main process, the state cookie
// would end up in Node's fetch context and cause a state_mismatch on the callback.
ipcMain.handle('auth:oauth-open-browser', async (_event, provider: string) => {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:3000';
  const url = `${apiBase}/api/auth/oauth-redirect/${encodeURIComponent(provider)}`;
  await shell.openExternal(url);
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Windows: deep link arrives as a command-line argument to the second instance
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = commandLine.find((arg) => arg.startsWith('drifting://'));
    if (deepLink) handleDeepLink(deepLink);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
