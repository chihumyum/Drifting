/**
 * Local development only: the Agent's own API keys, read from the ignored
 * `.env.local` / `.env` of this checkout and handed to the development server
 * under the `VITE_` names the renderer's EnvCredentialsProvider reads, so a
 * fresh development profile (every worktree and instance has its own keychain
 * service) starts connected instead of asking for keys again.
 *
 * A linked worktree has no env files of its own (they are not tracked), so
 * the main checkout's are read after the worktree's. Shell values win over
 * files, `.env.local` over `.env`. Builds and packaged apps never get these:
 * `VITE_` values are inlined into bundles. DRIFTING_DEV_AGENT_KEYS=0 turns it
 * off. Only provider names, never values, are reported.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Plain names are preferred in env files: Vite never exposes them to a build. */
export const DEV_AGENT_KEYS = {
  deepseek: {
    target: 'VITE_DEEPSEEK_API_KEY',
    sources: ['VITE_DEEPSEEK_API_KEY', 'VITE_DEEPSEEK_AI_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_AI_API_KEY'],
  },
  openai: {
    target: 'VITE_OPENAI_API_KEY',
    sources: ['VITE_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  },
};

/** The main checkout of the repository `directory` belongs to, or null. */
export function mainCheckoutRoot(directory, run = spawnSync) {
  const result = run('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const commonDirectory = result.stdout.trim();
  return commonDirectory ? path.dirname(commonDirectory) : null;
}

/** This checkout first, then the main checkout when this is a linked worktree. */
export function devAgentKeyRoots(directory, run = spawnSync) {
  // Git reports real paths; compare real paths so the main checkout is read once.
  const real = (root) => (existsSync(root) ? realpathSync(root) : path.resolve(root));
  return [...new Set([directory, mainCheckoutRoot(directory, run)].filter(Boolean).map(real))];
}

function readEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return parseEnv(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/** `{ VITE_DEEPSEEK_API_KEY?, VITE_OPENAI_API_KEY? }` for the dev server's environment. */
export function devAgentKeyEnvironment({ roots, baseEnvironment = process.env }) {
  if (baseEnvironment.DRIFTING_DEV_AGENT_KEYS === '0') return {};
  const layers = [
    baseEnvironment,
    ...roots.flatMap((root) => [readEnvFile(path.join(root, '.env.local')), readEnvFile(path.join(root, '.env'))]),
  ];
  const environment = {};
  for (const { target, sources } of Object.values(DEV_AGENT_KEYS)) {
    for (const layer of layers) {
      const value = sources.map((name) => layer[name]).find((candidate) => typeof candidate === 'string' && candidate.trim());
      if (value) {
        environment[target] = value.trim();
        break;
      }
    }
  }
  return environment;
}

/** The providers an environment carries keys for, e.g. ['deepseek', 'openai']. */
export function devAgentKeyProviders(environment) {
  return Object.entries(DEV_AGENT_KEYS)
    .filter(([, { target }]) => typeof environment[target] === 'string' && environment[target])
    .map(([provider]) => provider);
}

export function describeDevAgentKeys(environment) {
  const providers = devAgentKeyProviders(environment);
  const names = { deepseek: 'DeepSeek', openai: 'OpenAI' };
  return providers.length
    ? `Agent API keys from .env: ${providers.map((provider) => names[provider]).join(', ')} (development only)`
    : 'Agent API keys: none in .env / .env.local (set DEEPSEEK_API_KEY or OPENAI_API_KEY to start connected)';
}
