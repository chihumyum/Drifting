import { app, BrowserWindow, ipcMain, screen, shell, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import { setupDatabase } from './database';
import { registerKeyringIpc } from './keyring-ipc';
import { registerAiLogIpc } from './ai-log-ipc';
import { registerAgentIpc } from './agent';

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = parseEnvValue(trimmed.slice(separator + 1));
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnv(): void {
  const candidates = [
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '../../.env.local'),
    path.join(__dirname, '../../.env'),
  ];

  for (const filePath of candidates) {
    loadEnvFile(filePath);
  }
}

loadLocalEnv();

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
// Set to true once the renderer has acknowledged flushing pending writes
// (or the safety timer has elapsed). Required so the second `before-quit`
// emission — triggered by our re-entrant `app.quit()` call below — short
// circuits instead of looping forever.
let quitFlushDone = false;

const createWindow = () => {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: screen.getPrimaryDisplay().workAreaSize.width,
    height: screen.getPrimaryDisplay().workAreaSize.height,
    minWidth: 1000,
    minHeight: 700,
    title: 'Drifting',
    titleBarStyle: 'hiddenInset',
    // Initial position matches the modern skin (default). Renderer flips it
    // via `window:setTrafficLightPosition` when the skin changes — modern's
    // 6px app-root padding shifts the topbar down, classic sits flush at y=0.
    trafficLightPosition: { x: 18, y: 20 },
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
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
  // Setup database IPC handlers
  setupDatabase();
  // BYOK keychain IPC
  registerKeyringIpc();
  // AI request log writer
  registerAiLogIpc();
  // Claude Agent (SDK runs in main; streams to renderer over IPC)
  registerAgentIpc(() => mainWindow);

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

// Pre-quit flush. Cmd+Q (and any other path that ends in `app.quit()`)
// triggers `before-quit` before windows start closing. We give the renderer
// a chance to drain its in-flight writes — active editor → DB persist plus
// the debounced server-sync queue — before letting Electron shut everything
// down. A 2s timer guarantees we never hang the quit indefinitely.
app.on('before-quit', (event) => {
  if (quitFlushDone) return;
  const target = mainWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
    quitFlushDone = true;
    return;
  }
  event.preventDefault();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    quitFlushDone = true;
    ipcMain.removeListener('app:flush-before-quit-done', finish);
    app.quit();
  };

  const timer = setTimeout(finish, 2000);
  ipcMain.once('app:flush-before-quit-done', () => {
    clearTimeout(timer);
    finish();
  });

  try {
    target.webContents.send('app:flush-before-quit');
  } catch {
    clearTimeout(timer);
    finish();
  }
});

// Handle app updates and other IPC events
ipcMain.handle('app:getVersion', () => {
  return app.getVersion();
});

ipcMain.handle(
  'app:getPath',
  (_event, name: 'home' | 'appData' | 'userData' | 'temp' | 'documents') => {
    return app.getPath(name);
  },
);

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

// Renderer drives this whenever the appearance skin toggles. Modern adds 6px
// of padding around .app-root, so the 42-tall topbar starts at y=6 and the
// 14-tall buttons center at y=20; classic is flush at y=0 so they center at
// y=14. macOS only — other platforms ignore the call.
ipcMain.handle(
  'window:setTrafficLightPosition',
  (_event, position: { x: number; y: number }) => {
    if (process.platform !== 'darwin') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setWindowButtonPosition(position);
  },
);

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

// Material previews — opens a local file (image / pdf / …) in the user's
// default application. Returns the OS error string if the call fails so the
// renderer can surface a useful message. We don't try to invoke Quick Look
// natively here; PDFs and images go through Preview.app / Photos / whichever
// app is registered for the mime type.
ipcMain.handle('material:openLocal', async (_event, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, error: 'invalid path' };
  }
  const error = await shell.openPath(filePath);
  return error ? { ok: false, error } : { ok: true };
});

// Material previews — opens a URL in the system default browser. Mirrors the
// OAuth path so renderer code never has direct access to shell.openExternal.
ipcMain.handle('material:openExternal', async (_event, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

// Read a local file's raw bytes into the renderer. Used by the in-app PDF
// preview because pdf.js calls `fetch('file://…')` internally, which Chromium
// blocks when the renderer's origin is `http(s)://` (dev server) — that's a
// protocol-level restriction `webSecurity: false` doesn't lift. Cap at 64 MiB
// so a malformed pick doesn't OOM the main process.
ipcMain.handle('material:readBytes', async (_event, filePath: string) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, error: 'invalid path' } as const;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > 64 * 1024 * 1024) {
      return { ok: false, error: 'file too large (>64 MiB)' } as const;
    }
    const buf = await fs.promises.readFile(filePath);
    // Slice so we return a tight ArrayBuffer (no shared pool memory).
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { ok: true, bytes: ab } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
});

// Generate an inline thumbnail (base64 data URL) for a local file. macOS
// routes PDFs through Quick Look's renderer here, so it works out-of-the-box
// for PDFs and most image formats without bundling a PDF library.
ipcMain.handle(
  'material:thumbnail',
  async (_event, filePath: string, size = 96) => {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return { ok: false, error: 'invalid path' } as const;
    }
    try {
      const { nativeImage } = await import('electron');
      const image = await nativeImage.createThumbnailFromPath(filePath, {
        width: size,
        height: size,
      });
      if (image.isEmpty()) return { ok: false, error: 'empty thumbnail' } as const;
      const dataUrl = image.toDataURL();
      return { ok: true, dataUrl } as const;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
  },
);

// Resolve a remote URL's <title>, <meta property="og:image">, and favicon
// from the main process. Doing this in main keeps it CORS-free and out of the
// renderer's network context. We cap the body read at 256 KiB — the <head>
// is always near the top of the document, so we don't need the rest.
ipcMain.handle('material:resolveUrlMeta', async (_event, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'invalid url' } as const;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      signal: controller.signal,
      // Mimic a normal browser so sites don't 403 the request.
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Drifting/1.0',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` } as const;

    // Read up to 256 KiB. We only need <head>; HTML is well within this.
    const reader = res.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    const MAX = 256 * 1024;
    if (reader) {
      while (received < MAX) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    const buf = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c.subarray(0, Math.min(c.length, MAX - offset)), offset);
      offset += c.length;
      if (offset >= MAX) break;
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);

    const matchAttr = (re: RegExp): string | null => {
      const m = html.match(re);
      return m && m[1] ? m[1].trim() : null;
    };
    const decodeEntities = (s: string) =>
      s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ');

    const title =
      matchAttr(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
      matchAttr(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ??
      matchAttr(/<title[^>]*>([^<]+)<\/title>/i);
    const ogImage =
      matchAttr(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
      matchAttr(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const favicon =
      matchAttr(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i) ??
      matchAttr(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);

    const resolveAgainst = (val: string | null): string | null => {
      if (!val) return null;
      try {
        return new URL(val, url).toString();
      } catch {
        return null;
      }
    };

    return {
      ok: true,
      title: title ? decodeEntities(title) : null,
      ogImage: resolveAgainst(ogImage),
      favicon: resolveAgainst(favicon),
    } as const;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } as const;
  }
});

// Native file picker used when the user attaches a local image / PDF to a
// material. We intentionally do NOT copy the file anywhere — the absolute
// path is stored as-is so previews open the user's actual file. If the user
// later moves or deletes the file, the material's preview will fail; that's
// surfaced as a Quick Look / OS error.
ipcMain.handle(
  'material:pickFile',
  async (_event, kind: 'image' | 'pdf' | 'any' = 'any') => {
    const { dialog } = await import('electron');
    const filters: Electron.FileFilter[] = [];
    if (kind === 'image') {
      filters.push({ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'] });
    } else if (kind === 'pdf') {
      filters.push({ name: 'PDFs', extensions: ['pdf'] });
    }
    filters.push({ name: 'All Files', extensions: ['*'] });
    const result = await dialog.showOpenDialog(mainWindow ?? undefined!, {
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true } as const;
    }
    const filePath = result.filePaths[0];
    let sizeBytes: number | null = null;
    try {
      const { statSync } = await import('node:fs');
      sizeBytes = statSync(filePath).size;
    } catch {
      sizeBytes = null;
    }
    return { ok: true, filePath, sizeBytes } as const;
  },
);

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
