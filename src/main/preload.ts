import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPath: (name: string) => ipcRenderer.invoke('app:getPath', name),

  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },

  // Database operations
  db: {
    init: (dbName: string) => ipcRenderer.invoke('db:init', dbName),
    run: (sql: string, params?: any[]) => ipcRenderer.invoke('db:run', sql, params),
    query: (sql: string, params?: any[]) => ipcRenderer.invoke('db:query', sql, params),
    get: (sql: string, params?: any[]) => ipcRenderer.invoke('db:get', sql, params),
    close: () => ipcRenderer.invoke('db:close'),
  },

  // BYOK secrets — never touch the renderer directly, always via main.
  keychain: {
    get: (key: string) => ipcRenderer.invoke('keychain:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('keychain:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('keychain:delete', key),
  },

  // Material previews — main-process bridges so the renderer never touches
  // shell.* directly. `openLocal` defers to the OS default app (Preview.app /
  // Photos / …); `openExternal` opens an http(s) URL in the system browser.
  material: {
    openLocal: (filePath: string) =>
      ipcRenderer.invoke('material:openLocal', filePath) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    openExternal: (url: string) =>
      ipcRenderer.invoke('material:openExternal', url) as Promise<
        { ok: true } | { ok: false; error: string }
      >,
    pickFile: (kind?: 'image' | 'pdf' | 'any') =>
      ipcRenderer.invoke('material:pickFile', kind ?? 'any') as Promise<
        | { ok: true; filePath: string; sizeBytes: number | null }
        | { ok: false; canceled: true }
      >,
    thumbnail: (filePath: string, size?: number) =>
      ipcRenderer.invoke('material:thumbnail', filePath, size ?? 96) as Promise<
        { ok: true; dataUrl: string } | { ok: false; error: string }
      >,
    resolveUrlMeta: (url: string) =>
      ipcRenderer.invoke('material:resolveUrlMeta', url) as Promise<
        | { ok: true; title: string | null; ogImage: string | null; favicon: string | null }
        | { ok: false; error: string }
      >,
  },

  // OAuth: open system browser for social login
  auth: {
    openOAuthBrowser: (provider: string) => ipcRenderer.invoke('auth:oauth-open-browser', provider),
    onOAuthCallback: (callback: (data: { token: string | null; error: string | null }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { token: string | null; error: string | null },
      ) => callback(data);
      ipcRenderer.on('auth:oauth-callback', handler);
      return () => ipcRenderer.removeListener('auth:oauth-callback', handler);
    },
  },
});

// Type definitions for TypeScript
export interface ElectronAPI {
  getVersion: () => Promise<string>;
  getPath: (name: string) => Promise<string>;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
  };
  db: {
    init: (dbName: string) => Promise<void>;
    run: (sql: string, params?: any[]) => Promise<{ changes: number; lastInsertRowid: number }>;
    query: (sql: string, params?: any[]) => Promise<any[]>;
    get: (sql: string, params?: any[]) => Promise<any | undefined>;
    close: () => Promise<void>;
  };
  auth: {
    openOAuthBrowser: (provider: string) => Promise<void>;
    onOAuthCallback: (
      callback: (data: { token: string | null; error: string | null }) => void,
    ) => () => void;
  };
  keychain: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
  material: {
    openLocal: (
      filePath: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    openExternal: (
      url: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    pickFile: (
      kind?: 'image' | 'pdf' | 'any',
    ) => Promise<
      | { ok: true; filePath: string; sizeBytes: number | null }
      | { ok: false; canceled: true }
    >;
    thumbnail: (
      filePath: string,
      size?: number,
    ) => Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>;
    resolveUrlMeta: (
      url: string,
    ) => Promise<
      | { ok: true; title: string | null; ogImage: string | null; favicon: string | null }
      | { ok: false; error: string }
    >;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
