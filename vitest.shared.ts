import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export function createVitestConfig(include: string[]) {
  return defineConfig({
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    test: {
      environment: 'node',
      include,
      // Real LLM round-trips (thinking on) are slow; give each case room.
      testTimeout: 180_000,
      hookTimeout: 60_000,
      // Stream console.log immediately instead of buffering it until each test ends.
      // Long evals print progress continuously and should never look frozen.
      disableConsoleIntercept: true,
    },
  });
}
