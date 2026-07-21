import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Headless unit-test runner for renderer-side logic. Production builds use
// Tauri + Vite; this config keeps the same `@` alias and `import.meta.env` in a
// node context. Long-running Shadow evals are invoked explicitly by eval scripts.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Real LLM round-trips (thinking on) are slow; give each case room.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Stream console.log immediately instead of buffering it until each test ends.
    // The long eval prints ▶/✓ per chapter as a progress meter — buffered, it would
    // look frozen for the whole run (exactly the "卡住" symptom).
    disableConsoleIntercept: true,
  },
});
