import { createVitestConfig } from './vitest.shared';

// Keep long-running and potentially credentialed evaluations out of `pnpm test`.
// Eval scripts opt into this collection boundary explicitly.
export default createVitestConfig(['src/**/*.eval.ts']);
