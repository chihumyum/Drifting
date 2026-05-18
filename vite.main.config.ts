import { defineConfig } from 'vite';
import path from 'node:path';

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // Some libs that can run in both Web and Node.js environments
    // will export Node.js module by default, but Vite may build error
    // So we need to specify them as external
    browserField: false,
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext'],
  },
  build: {
    rollupOptions: {
      external: [
        // Native modules must be external — rollup can't bundle .node binaries.
        'better-sqlite3',
        '@napi-rs/keyring',
        // Match every platform-suffixed prebuild (-darwin-arm64 / -linux-x64 / ...).
        /^@napi-rs\/keyring-/,
        // Also exclude electron and node built-ins
        'electron',
        'fs',
        'path',
        'crypto',
      ],
    },
  },
});
