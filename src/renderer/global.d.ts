/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_URL: string;
  readonly VITE_LOCAL_ONLY_MODE?: string;
  readonly VITE_ENABLE_SYNC?: string;
  readonly VITE_REQUIRE_AUTH?: string;
  readonly VITE_DEV_SESSION_STORAGE?: 'local' | 'keychain';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
