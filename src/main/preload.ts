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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
