import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEventEnvelope, AgentStartInput } from './agent';
import type { ToolExecRequest, ToolExecResult } from './agent/bridge';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPath: (name: string) => ipcRenderer.invoke('app:getPath', name),

  // Cmd+Q safety: the main process pings us right before terminating so the
  // renderer can drain pending writes (active editor save, sync queue, etc.).
  // Renderer subscribes via `onFlushBeforeQuit`; the unsubscribe fn it gets
  // back is rarely used (the app is on its way out), but matches our other
  // listener APIs. Call `confirmFlushBeforeQuit()` once flushes resolve to
  // release the main process so it can quit immediately.
  onFlushBeforeQuit: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:flush-before-quit', handler);
    return () => ipcRenderer.removeListener('app:flush-before-quit', handler);
  },
  confirmFlushBeforeQuit: () => ipcRenderer.send('app:flush-before-quit-done'),

  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    setTrafficLightPosition: (position: { x: number; y: number }) =>
      ipcRenderer.invoke('window:setTrafficLightPosition', position),
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
    readBytes: (filePath: string) =>
      ipcRenderer.invoke('material:readBytes', filePath) as Promise<
        { ok: true; bytes: ArrayBuffer } | { ok: false; error: string }
      >,
    resolveUrlMeta: (url: string) =>
      ipcRenderer.invoke('material:resolveUrlMeta', url) as Promise<
        | { ok: true; title: string | null; ogImage: string | null; favicon: string | null }
        | { ok: false; error: string }
      >,
  },

  // AI request log — markdown file per request, written to userData/ai-log/.
  // Renderer formats the body; main only writes + opens the directory.
  aiLog: {
    write: (filename: string, content: string) =>
      ipcRenderer.invoke('ai-log:write', { filename, content }) as Promise<
        { ok: true; filePath: string } | { ok: false; error: string }
      >,
    openDir: () => ipcRenderer.invoke('ai-log:openDir') as Promise<string>,
    getDir: () => ipcRenderer.invoke('ai-log:getDir') as Promise<string>,
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

  // Claude Agent — SDK runs in main, streams events here over `agent:event`.
  agent: {
    authPrepare: () => ipcRenderer.invoke('agent:auth-prepare'),
    authSubmitCode: (code: string) => ipcRenderer.invoke('agent:auth-submit-code', code),
    authStatus: () => ipcRenderer.invoke('agent:auth-status'),
    authLogout: () => ipcRenderer.invoke('agent:auth-logout'),
    start: (input: AgentStartInput) => ipcRenderer.invoke('agent:start', input),
    abort: () => ipcRenderer.invoke('agent:abort'),
    resetSession: () => ipcRenderer.invoke('agent:reset-session'),
    onEvent: (callback: (env: AgentEventEnvelope) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, env: AgentEventEnvelope) => callback(env);
      ipcRenderer.on('agent:event', handler);
      return () => ipcRenderer.removeListener('agent:event', handler);
    },
    // Tool bridge: main asks the renderer to run an entity tool, renderer replies.
    onToolExec: (callback: (req: ToolExecRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, req: ToolExecRequest) => callback(req);
      ipcRenderer.on('agent:tool-exec', handler);
      return () => ipcRenderer.removeListener('agent:tool-exec', handler);
    },
    sendToolResult: (result: ToolExecResult) => ipcRenderer.send('agent:tool-result', result),
  },
});

// Type definitions for TypeScript
export interface ElectronAPI {
  getVersion: () => Promise<string>;
  getPath: (name: string) => Promise<string>;
  onFlushBeforeQuit: (callback: () => void) => () => void;
  confirmFlushBeforeQuit: () => void;
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    setTrafficLightPosition: (position: { x: number; y: number }) => Promise<void>;
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
  agent: {
    authPrepare: () => Promise<{ url: string }>;
    authSubmitCode: (
      code: string,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    authStatus: () => Promise<{
      byokConnected: boolean;
      apiKeyConnected: boolean;
      hostedAvailable: boolean;
    }>;
    authLogout: () => Promise<{ ok: true }>;
    start: (
      input: AgentStartInput,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    abort: () => Promise<{ ok: true }>;
    resetSession: () => Promise<{ ok: true }>;
    onEvent: (callback: (env: AgentEventEnvelope) => void) => () => void;
    onToolExec: (callback: (req: ToolExecRequest) => void) => () => void;
    sendToolResult: (result: ToolExecResult) => void;
  };
  aiLog: {
    write: (
      filename: string,
      content: string,
    ) => Promise<{ ok: true; filePath: string } | { ok: false; error: string }>;
    openDir: () => Promise<string>;
    getDir: () => Promise<string>;
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
    readBytes: (
      filePath: string,
    ) => Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }>;
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
