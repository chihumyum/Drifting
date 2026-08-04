import { createVitestConfig } from './vitest.shared';

// Headless unit-test runner for renderer-side logic. Production builds use
// Tauri + Vite; this config keeps the same `@` alias and `import.meta.env` in a
// node context. Long-running live evals are invoked explicitly by eval scripts.
export default createVitestConfig(['src/**/*.test.ts']);
