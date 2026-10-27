#!/usr/bin/env node

// pnpm dev:seed — an isolated worktree profile (run-worktree-dev.mjs) whose
// library starts with a synthetic project (src/dev-cli/seed.ts). The first
// launch of an instance seeds it; later launches reuse what is there.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertWorktreePortAvailable,
  createWorktreePlan,
  parseWorktreeArguments,
  runWorktreeDev,
} from './run-worktree-dev.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '..');

/** Seeded profiles default to their own instance, apart from `pnpm dev:worktree`'s. */
export const SEED_INSTANCE = 'seed';
/** The local-only library file (`store/auth`'s LOCAL_USER_ID). */
export const LOCAL_LIBRARY_DATABASE = 'drifting-library.db';

const usage = 'Usage: pnpm dev:seed [--instance <name>] [--port <number>] [--no-watch] [--print-config]\n'
  + 'Starts an isolated local-only profile (default instance "seed") whose library begins with a synthetic\n'
  + 'project. The first launch of an instance seeds it; choose a new --instance for fresh data.';

/** The launcher arguments: the seed instance unless one is named; local-only. */
export function seededArguments(args) {
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  const options = parseWorktreeArguments(forwarded);
  if (options.online) throw new Error('pnpm dev:seed seeds a local-only profile; --online is not supported.');
  return forwarded.includes('--instance') ? forwarded : [...forwarded, '--instance', SEED_INSTANCE];
}

function runSeedProcess({ root, databasePath }) {
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', '--conditions=import', 'src/dev-cli/seed-main.ts', '--db', databasePath],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-warnings'].filter(Boolean).join(' ') },
    },
  );
  if (result.status !== 0) throw new Error(`Seeding ${databasePath} failed (exit ${result.status ?? result.signal}).`);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

export async function runSeededDev(args = process.argv.slice(2), {
  root = defaultRoot, baseEnvironment = process.env, seed = runSeedProcess,
  checkPort = assertWorktreePortAvailable, launch = runWorktreeDev, output = console.log,
} = {}) {
  const launchArguments = seededArguments(args);
  const options = parseWorktreeArguments(launchArguments);
  if (options.help) {
    output(usage);
    return;
  }
  if (!options.printConfig) {
    const plan = createWorktreePlan({ root, baseEnvironment, ...options });
    // A running profile owns its database; never seed underneath it.
    await checkPort(plan.manifest.port);
    const result = seed({ root, databasePath: path.join(plan.manifest.databaseDirectory, LOCAL_LIBRARY_DATABASE) });
    output(result.seeded
      ? `Seeded a synthetic project into instance "${options.instance}".`
      : `Instance "${options.instance}" already has a library; launching it as it is.`);
  }
  await launch(launchArguments, { root, baseEnvironment });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runSeededDev().catch(error => { console.error(error.message); process.exitCode = 1; });
}
