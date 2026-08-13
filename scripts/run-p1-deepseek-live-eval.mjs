/**
 * Explicit opt-in launcher for credentialed DeepSeek Agent evaluations.
 *
 * DEEPSEEK_AI_API_KEY must be provided explicitly by the caller. The value is
 * passed to the dedicated Vitest child process and is never printed or persisted.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitestEntry = path.resolve(coreDir, 'node_modules', 'vitest', 'vitest.mjs');
const suite = process.env.DRIFTING_AGENT_LIVE_SUITE ?? 'p1';
const evalFiles = {
  p1: 'src/renderer/lib/agent/runtime/eval/p1-deepseek-live.eval.ts',
  'product-canary': 'src/renderer/lib/agent/runtime/eval/agent-product-canary.live.eval.ts',
  'writing-canary': 'src/renderer/lib/agent/runtime/eval/agent-writing-canary.live.eval.ts',
  'concurrent-writing-canary':
    'src/renderer/lib/agent/runtime/eval/agent-concurrent-writing-canary.live.eval.ts',
};
const evalFile = evalFiles[suite];
if (!evalFile) {
  console.error(
    'DRIFTING_AGENT_LIVE_SUITE must be "p1", "product-canary", "writing-canary", or "concurrent-writing-canary".',
  );
  process.exitCode = 1;
  process.exit();
}

const apiKey = process.env.DEEPSEEK_AI_API_KEY?.trim();
if (!apiKey) {
  console.error('P1 live eval requires DEEPSEEK_AI_API_KEY in the process environment.');
  process.exitCode = 1;
  process.exit();
}

const child = spawn(
  process.execPath,
  [
    vitestEntry,
    'run',
    '--config',
    'vitest.eval.config.ts',
    evalFile,
    '--pool=forks',
    '--maxWorkers=1',
  ],
  {
    cwd: coreDir,
    env: {
      ...process.env,
      DEEPSEEK_AI_API_KEY: apiKey,
      DRIFTING_AGENT_LIVE_EVAL: '1',
      EVAL_REPEAT: process.env.EVAL_REPEAT ?? '3',
    },
    stdio: 'inherit',
  },
);

child.once('error', () => {
  console.error('P1 live eval could not start its isolated Node test process.');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
