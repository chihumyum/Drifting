#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDesktopTauriEnvironment, prepareDesktopSigning } from './run-desktop-tauri.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), '..');
const instancePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function parseWorktreeArguments(args) {
  const options = { instance: 'default', printConfig: false, noWatch: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--' && index === 0) continue;
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--print-config') options.printConfig = true;
    else if (argument === '--no-watch') options.noWatch = true;
    else if (argument === '--instance' || argument === '--port') {
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`${argument} requires a value`);
      if (argument === '--instance') options.instance = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error('--port must be an integer');
        options.port = Number(value);
      }
    } else throw new Error(`Unknown option: ${argument}. Run pnpm dev:worktree --help.`);
  }
  if (!instancePattern.test(options.instance)) throw new Error('--instance must use 1–40 lowercase letters, digits or hyphens');
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) {
    throw new Error('--port must be between 1024 and 65535');
  }
  return options;
}

// Refuse aliases of another profile's state, including an existing symlinked
// .local-data. The checkout itself may be reached through a symlink.
export function assertPrivateProfilePath(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Profile must be inside this checkout');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Worktree isolation refuses a symlink: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function createWorktreePlan({
  root = defaultRoot, instance = 'default', port, noWatch = false,
  baseEnvironment = process.env, platform = process.platform,
} = {}) {
  if (!instancePattern.test(instance)) throw new Error('Invalid worktree instance name');
  const worktreeRoot = realpathSync(root);
  const digest = createHash('sha256').update(`${worktreeRoot}\0${instance}`).digest();
  const profileId = digest.toString('hex').slice(0, 12);
  const profileDirectory = path.join(worktreeRoot, '.local-data', 'worktree-dev', profileId);
  const databaseDirectory = path.join(profileDirectory, 'databases');
  const cargoTargetDirectory = path.join(profileDirectory, 'target');
  const configPath = path.join(profileDirectory, 'tauri.conf.json');
  const viteConfigPath = path.join(profileDirectory, 'vite.config.mjs');
  for (const target of [databaseDirectory, cargoTargetDirectory, configPath, viteConfigPath]) assertPrivateProfilePath(worktreeRoot, target);
  const selectedPort = port ?? (20000 + digest.readUInt32BE(0) % 20000);
  if (!Number.isInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) throw new Error('Invalid worktree port');
  const identifier = `cc.drifting.wt.w${profileId}`;
  const devUrl = `http://127.0.0.1:${selectedPort}`;
  const loaded = createDesktopTauriEnvironment({ baseEnvironment, envFile: path.join(worktreeRoot, '.env.local') });
  // Keep the host toolchain and signing setup. Do not inherit app profiles,
  // hosted sessions, debug bridge endpoints, custom runners or Vite secrets.
  const environment = Object.fromEntries(Object.entries(loaded).filter(([key]) =>
    !/^(?:VITE_|DRIFTING_|TAURI_|CARGO_TARGET_.*_RUNNER$)/.test(key)));
  if (loaded.DRIFTING_MACOS_DEV_SIGNING_IDENTITY) environment.DRIFTING_MACOS_DEV_SIGNING_IDENTITY = loaded.DRIFTING_MACOS_DEV_SIGNING_IDENTITY;
  Object.assign(environment, {
    DRIFTING_DB_DIR: databaseDirectory,
    DRIFTING_VITE_PORT: String(selectedPort),
    DRIFTING_MACOS_DEV_CODE_IDENTIFIER: identifier,
    CARGO_TARGET_DIR: cargoTargetDirectory,
    CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER: path.join(worktreeRoot, 'scripts/run-signed-macos-dev.sh'),
    CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER: path.join(worktreeRoot, 'scripts/run-signed-macos-dev.sh'),
    VITE_LOCAL_ONLY_MODE: 'true', VITE_REQUIRE_AUTH: 'false', VITE_AI_TRANSPORT: 'direct',
    VITE_CLOSED_BETA: 'false', VITE_API_BASE_URL: 'http://localhost:3000', API_BASE_URL: 'http://localhost:3000',
  });
  const base = JSON.parse(readFileSync(path.join(worktreeRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  // The installed Tauri code generator emits Vec<u8> for dataStoreIdentifier,
  // while its runtime requires [u8; 16]. Ephemeral WKWebView stores work on all
  // supported macOS versions without changing the product's Rust code.
  const ephemeralWebview = platform === 'darwin';
  const tauriConfig = {
    identifier,
    productName: `Drifting Test ${profileId}`,
    build: {
      devUrl,
      beforeDevCommand: {
        // Only generated hex characters enter this shell command; the checkout
        // path is supplied as cwd, never interpolated into a shell string.
        script: `pnpm exec vite --config .local-data/worktree-dev/${profileId}/vite.config.mjs`,
        cwd: worktreeRoot,
      },
    },
    app: {
      windows: base.app.windows.map(window => ({
        ...window, title: `Drifting Test · ${instance} · ${profileId}`,
        dataDirectory: `worktree-${profileId}`,
        incognito: ephemeralWebview,
      })),
      security: {
        devCsp: base.app.security.devCsp.replace(/\bconnect-src\b[^;]*/, directive =>
          `${directive} ${devUrl} ws://127.0.0.1:${selectedPort}`),
      },
    },
    bundle: { createUpdaterArtifacts: false },
    plugins: { 'deep-link': { desktop: { schemes: [`drifting-test-${profileId}`] } } },
  };
  const viteConfigSource = `import { mergeConfig } from 'vite';
import base from '../../../vite.renderer.config.ts';
export default async env => mergeConfig(await (typeof base === 'function' ? base(env) : base), {
  envDir: false,
  cacheDir: ${JSON.stringify(path.join(profileDirectory, 'vite-cache'))},
  server: { host: '127.0.0.1', port: ${selectedPort}, strictPort: true, hmr: true }
});
`;
  // This is deliberately a non-secret manifest, not a dump of process.env.
  const manifest = {
    schemaVersion: 1, worktreeRoot, instance, profileId, identifier,
    profileDirectory, databaseDirectory, cargoTargetDirectory, devUrl, port: selectedPort,
    keychainService: `Drifting.${identifier}`, ephemeralWebview,
    mode: 'local-only', configPath,
  };
  return {
    manifest, environment, tauriConfig, viteConfigSource, viteConfigPath,
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['exec', 'tauri', 'dev', ...(noWatch ? ['--no-watch'] : []), '--config', configPath],
  };
}

export async function assertWorktreePortAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(new Error(`Worktree port ${port} is unavailable (${error.code}); stop its owner or choose --port <number>.`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function runWorktreeDev(args = process.argv.slice(2), {
  root = defaultRoot, baseEnvironment = process.env,
  spawnProcess = spawn, checkPort = assertWorktreePortAvailable, prepareSigning = prepareDesktopSigning,
  signals = process, output = console.log,
} = {}) {
  const options = parseWorktreeArguments(args);
  if (options.help) {
    output('Usage: pnpm dev:worktree [--instance <name>] [--port <number>] [--no-watch] [--print-config]\nLocal-only, persistent isolated state per checkout and instance. --print-config emits JSON without launching or creating files.');
    return;
  }
  const plan = createWorktreePlan({ root, baseEnvironment, ...options });
  if (options.printConfig) { output(JSON.stringify(plan.manifest, null, 2)); return; }
  await checkPort(plan.manifest.port);
  prepareSigning({ command: 'dev', environment: plan.environment });
  mkdirSync(plan.manifest.databaseDirectory, { recursive: true, mode: 0o700 });
  for (const [file, contents] of [
    [plan.manifest.configPath, JSON.stringify(plan.tauriConfig, null, 2)],
    [plan.viteConfigPath, plan.viteConfigSource],
    [path.join(plan.manifest.profileDirectory, 'profile.json'), JSON.stringify(plan.manifest, null, 2)],
  ]) {
    assertPrivateProfilePath(plan.manifest.worktreeRoot, file);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== `${contents}\n`) writeFileSync(file, `${contents}\n`, { mode: 0o600 });
  }
  output(JSON.stringify(plan.manifest));
  const child = spawnProcess(plan.command, plan.args, {
    cwd: plan.manifest.worktreeRoot, env: plan.environment, stdio: 'inherit',
    // A process group lets headless automation stop Cargo, Vite and the app,
    // including descendants of pnpm, using a single SIGINT/SIGTERM.
    detached: process.platform !== 'win32',
  });
  const stop = signal => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let requestedSignal = null;
  const onInterrupt = () => { requestedSignal = 'SIGINT'; stop(requestedSignal); };
  const onTerminate = () => { requestedSignal = 'SIGTERM'; stop(requestedSignal); };
  signals.on('SIGINT', onInterrupt);
  signals.on('SIGTERM', onTerminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        if (code === 0 || requestedSignal) resolve();
        else reject(new Error(`Isolated Tauri dev exited with ${signal ?? code}`));
      });
    });
  } finally {
    // A requested signal already reached the whole group. Do not signal it a
    // second time after pnpm reaps its children (macOS may report EPERM then).
    if (!requestedSignal) stop('SIGTERM');
    signals.removeListener('SIGINT', onInterrupt);
    signals.removeListener('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runWorktreeDev().catch(error => { console.error(error.message); process.exitCode = 1; });
}
