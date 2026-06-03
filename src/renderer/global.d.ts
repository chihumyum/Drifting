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
