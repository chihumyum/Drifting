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
        // Native modules must be external
        'better-sqlite3',
        // Also exclude electron and node built-ins
        'electron',
        'fs',
        'path',
        'crypto',
      ],
    },
  },
});
