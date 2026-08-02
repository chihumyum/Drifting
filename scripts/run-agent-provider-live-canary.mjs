import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provider = process.env.DRIFTING_AGENT_LIVE_PROVIDER ?? 'deepseek';
if (!['deepseek', 'anthropic', 'openai'].includes(provider)) {
  throw new Error('DRIFTING_AGENT_LIVE_PROVIDER must be deepseek, anthropic, or openai');
}
const child = spawn(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.eval.config.ts',
    'src/renderer/lib/agent/runtime/eval/provider-extension.live.eval.ts',
    '--pool=forks',
    '--maxWorkers=1',
  ],
  {
    cwd: core,
    env: { ...process.env, DRIFTING_AGENT_PROVIDER_CANARY: '1' },
    stdio: 'inherit',
  },
);
child.once('error', () => {
  process.stderr.write('Provider canary could not start.\n');
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
