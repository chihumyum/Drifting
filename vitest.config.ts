import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Headless test/eval runner. The app builds via electron-forge + plugin-vite;
// this config exists purely so Vitest can run renderer-side logic (shadow judge
// eval, pure-function tests) in a node context with the same `@` alias and Vite's
// `import.meta.env`. No DOM is needed — the judge takes its world as arguments.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.eval.ts', 'src/**/*.test.ts'],
    // Real LLM round-trips (thinking on) are slow; give each case room.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Stream console.log immediately instead of buffering it until each test ends.
    // The long eval prints ▶/✓ per chapter as a progress meter — buffered, it would
    // look frozen for the whole run (exactly the "卡住" symptom).
    disableConsoleIntercept: true,
  },
});
