/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_URL: string;
  readonly VITE_LOCAL_ONLY_MODE?: string;
  readonly VITE_ENABLE_SYNC?: string;
  readonly VITE_REQUIRE_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Electron API types
interface ElectronAPI {
  getVersion: () => Promise<string>;
  getPath: (name: string) => Promise<string>;
  db: {
    init: (dbName: string) => Promise<void>;
    run: (sql: string, params?: any[]) => Promise<{ changes: number; lastInsertRowid: number }>;
    query: (sql: string, params?: any[]) => Promise<any[]>;
    get: (sql: string, params?: any[]) => Promise<any | undefined>;
    close: () => Promise<void>;
  };
  window?: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    setTrafficLightPosition: (position: { x: number; y: number }) => Promise<void>;
  };
  shadow?: {
    enqueue: (job: { projectId: string; chapterId: string }) => void;
    run: (job: {
      projectId: string;
      chapterId: string;
    }) => Promise<{ chapterId: string; decision: 'finished' | 'draft'; findingCount: number }>;
    cancel: (job: { chapterId: string }) => void;
    onJob: (
      callback: (ev: {
        chapterId: string;
        projectId: string;
        state: 'started' | 'completed' | 'failed';
        decision?: 'finished' | 'draft';
        findingCount?: number;
        error?: string;
      }) => void,
    ) => () => void;
  };
  material: {
    openLocal: (filePath: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    openExternal: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    pickFile: (
      kind?: 'image' | 'pdf' | 'any',
    ) => Promise<
      { ok: true; filePath: string; sizeBytes: number | null } | { ok: false; canceled: true }
    >;
    thumbnail: (
      filePath: string,
      size?: number,
    ) => Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>;
    readBytes: (
      filePath: string,
    ) => Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }>;
    inspectImage: (
      filePath: string,
    ) => Promise<
      | { ok: true; mime: string; sizeBytes: number; width: number; height: number }
      | { ok: false; error: string }
    >;
    createImageVariant: (
      filePath: string,
      maxLongEdge: number,
      quality: number,
    ) => Promise<
      | {
          ok: true;
          bytes: ArrayBuffer;
          mime: string;
          sizeBytes: number;
          width: number;
          height: number;
        }
      | { ok: false; error: string }
    >;
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

declare module 'react' {
  interface CSSProperties {
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}

export {};
