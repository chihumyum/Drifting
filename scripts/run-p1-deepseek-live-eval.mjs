/**
 * Explicit opt-in launcher for the credentialed P1 Agent evaluation.
 *
 * Only DEEPSEEK_AI_API_KEY is selected from private-service/.env. The value is
 * passed to the dedicated Vitest child process and is never printed, persisted,
 * or exported into the caller's shell.
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEnvPath = path.resolve(coreDir, '..', 'private service', '.env');
const vitestEntry = path.resolve(coreDir, '..', 'node_modules', 'vitest', 'vitest.mjs');
const suite = process.env.DRIFTING_AGENT_LIVE_SUITE ?? 'p1';
const evalFiles = {
  p1: 'src/renderer/lib/agent/runtime/eval/p1-deepseek-live.eval.ts',
  'product-canary': 'src/renderer/lib/agent/runtime/eval/agent-product-canary.live.eval.ts',
  'writing-canary': 'src/renderer/lib/agent/runtime/eval/agent-writing-canary.live.eval.ts',
};
const evalFile = evalFiles[suite];
if (!evalFile) {
  console.error('DRIFTING_AGENT_LIVE_SUITE must be "p1", "product-canary", or "writing-canary".');
  process.exitCode = 1;
  process.exit();
}

let envSource;
try {
  envSource = await readFile(serverEnvPath, 'utf8');
} catch {
  console.error('P1 live eval requires private-service/.env (file was not readable).');
  process.exitCode = 1;
  process.exit();
}

const apiKey = readEnvValue(envSource, 'DEEPSEEK_AI_API_KEY');
if (!apiKey) {
  console.error('P1 live eval requires DEEPSEEK_AI_API_KEY in private-service/.env.');
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

function readEnvValue(source, name) {
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'u'));
    if (!match) continue;
    const raw = match[1].trim();
    if (!raw) return '';
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw.replace(/\s+#.*$/u, '').trim();
  }
  return '';
}
