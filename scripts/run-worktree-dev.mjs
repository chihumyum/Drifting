#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createDesktopTauriEnvironment, prepareDesktopSigning } from './run-desktop-tauri.mjs';
import { describeDevAgentKeys, devAgentKeyEnvironment, devAgentKeyProviders, devAgentKeyRoots } from './dev-agent-keys.mjs';
import { hostedSecurityOverride } from './hosted-environment.mjs';
import { sentrySecurityOverride } from './sentry-environment.mjs';

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
    else if (argument === '--performance-audit') options.performanceAudit = true;
    else if (argument === '--online') options.online = true;
    else if (argument === '--build-app') options.buildApp = true;
    else if (argument === '--frontend-debug') options.frontendDebug = true;
    else if (argument === '--release-perf') options.releasePerf = true;
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

// Match Tauri app_local_data_dir (directories::BaseDirs), including XDG on
// Linux. Assets use this root even when DRIFTING_DB_DIR lives in the checkout.
export function worktreeAppLocalDataRoot({ platform = process.platform, environment = process.env } = {}) {
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support');
  if (platform === 'win32') return environment.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  return environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
    ? environment.XDG_DATA_HOME : path.join(homedir(), '.local', 'share');
}

// The desktop Frontend Debug daemon started from this checkout
// (`pnpm drifting frontend serve --platform desktop`) leaves its session here.
export function readDesktopFrontendDebugSession(worktreeRoot) {
  const sessionPath = path.join(worktreeRoot, '.local-data', 'frontend-debug', 'session.json');
  let session;
  try {
    session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  } catch {
    throw new Error(`--frontend-debug needs a running desktop daemon: start \`pnpm drifting frontend serve --platform desktop\` in this checkout first (no ${sessionPath}).`);
  }
  if (session?.schemaVersion !== 1 || session.platform !== 'desktop' || typeof session.token !== 'string'
    || session.host !== '127.0.0.1' || !Number.isInteger(session.port)) {
    throw new Error(`--frontend-debug needs a desktop session, but ${sessionPath} belongs to ${session?.platform ?? 'an unknown platform'}; restart the daemon with --platform desktop.`);
  }
  try {
    process.kill(session.pid, 0);
  } catch (error) {
    if (error.code !== 'EPERM') throw new Error(`The desktop Frontend Debug daemon (PID ${session.pid}) is no longer running; start it again.`);
  }
  return { url: `http://${session.host}:${session.port}`, token: session.token, transport: session.transport };
}

export function createWorktreePlan({
  root = defaultRoot, instance = 'default', port, noWatch = false, online = false, buildApp = false, performanceAudit = false,
  frontendDebug = false, releasePerf = false, baseEnvironment = process.env, platform = process.platform,
} = {}) {
  if (!instancePattern.test(instance)) throw new Error('Invalid worktree instance name');
  if (buildApp && platform !== 'darwin') throw new Error('--build-app currently supports macOS only');
  if (performanceAudit && buildApp) throw new Error('--performance-audit requires a Vite development instance');
  if (frontendDebug && buildApp) throw new Error('--frontend-debug requires a Vite development instance');
  if (releasePerf && (buildApp || performanceAudit || online)) {
    throw new Error('--release-perf measures a local-only instance; it cannot be combined with --build-app, --performance-audit or --online');
  }
  const worktreeRoot = realpathSync(root);
  const debugSession = frontendDebug ? readDesktopFrontendDebugSession(worktreeRoot) : null;
  const loaded = createDesktopTauriEnvironment({ baseEnvironment, envFile: path.join(worktreeRoot, '.env.local'), mode: online ? 'online' : 'local' });
  const origin = online ? loaded.DRIFTING_HOSTED_ORIGIN : null;
  const digest = createHash('sha256').update(`${worktreeRoot}\0${instance}${online ? `\0${origin}` : ''}${buildApp ? '\0packaged' : ''}`).digest();
  const profileId = digest.toString('hex').slice(0, 12);
  const profileDirectory = path.join(worktreeRoot, '.local-data', 'worktree-dev', profileId);
  const identifier = `cc.drifting.wt.w${profileId}`;
  const appLocalDataRoot = worktreeAppLocalDataRoot({ platform, environment: baseEnvironment });
  const appLocalDataDirectory = path.join(appLocalDataRoot, identifier);
  assertPrivateProfilePath(appLocalDataRoot, appLocalDataDirectory);
  const dataRoot = buildApp ? path.join(homedir(), 'Library', 'Application Support') : worktreeRoot;
  const databaseDirectory = buildApp ? path.join(dataRoot, identifier, 'databases') : path.join(profileDirectory, 'databases');
  assertPrivateProfilePath(dataRoot, databaseDirectory);
  const cargoTargetDirectory = path.join(profileDirectory, 'target');
  const configPath = path.join(profileDirectory, 'tauri.conf.json');
  const viteConfigPath = path.join(profileDirectory, 'vite.config.mjs');
  for (const target of [cargoTargetDirectory, configPath, viteConfigPath]) assertPrivateProfilePath(worktreeRoot, target);
  const selectedPort = port ?? (20000 + digest.readUInt32BE(0) % 20000);
  if (!Number.isInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) throw new Error('Invalid worktree port');
  const devUrl = `http://127.0.0.1:${selectedPort}`;
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
  if (online) Object.assign(environment, {
    VITE_LOCAL_ONLY_MODE: 'false', VITE_API_BASE_URL: origin, API_BASE_URL: origin,
    DRIFTING_HOSTED_ORIGIN: origin,
    VITE_SENTRY_DSN: loaded.VITE_SENTRY_DSN || '',
    VITE_SENTRY_RELEASE: loaded.VITE_SENTRY_RELEASE || '',
    VITE_SENTRY_ENVIRONMENT: loaded.VITE_SENTRY_ENVIRONMENT || 'development',
    VITE_DRIFTING_CRASH_REPORTS_IN_DEV: loaded.VITE_DRIFTING_CRASH_REPORTS_IN_DEV || '',
    // Where share links point; development runs the reader on its own server.
    VITE_SHARE_WEB_ORIGIN: loaded.VITE_SHARE_WEB_ORIGIN || '',
  });
  // Development only: the Agent's keys from the checkout's .env files (the
  // main checkout's too), so a fresh profile starts connected. A packaged app
  // never gets them; see scripts/dev-agent-keys.mjs.
  // A release-performance bundle is a production build: it embeds no keys.
  if (!buildApp && !releasePerf) Object.assign(environment, devAgentKeyEnvironment({ roots: devAgentKeyRoots(worktreeRoot), baseEnvironment }));
  if (releasePerf) environment.DRIFTING_PERF_BUILD = '1';
  // Only this explicit opt-in may hand the renderer a debug bridge endpoint;
  // the token stays in the environment and never reaches the manifest.
  if (debugSession) Object.assign(environment, {
    VITE_DRIFTING_FRONTEND_DEBUG: '1',
    VITE_DRIFTING_FRONTEND_DEBUG_TRANSPORT: debugSession.transport,
    VITE_DRIFTING_FRONTEND_DEBUG_URL: debugSession.url,
    VITE_DRIFTING_FRONTEND_DEBUG_TOKEN: debugSession.token,
  });
  const frontendDirectory = path.join(profileDirectory, 'frontend');
  // Production React and minified renderer for --release-perf, rebuilt on every
  // launch and served from the same port a development server would use.
  const perfFrontendDirectory = `.local-data/worktree-dev/${profileId}/frontend-perf`;
  const viteConfigArgument = `--config .local-data/worktree-dev/${profileId}/vite.config.mjs`;
  if (buildApp) Object.assign(environment, {
    DRIFTING_RENDERER_OUT_DIR: frontendDirectory,
    DRIFTING_SENTRY_PACKAGED_ACCEPTANCE: loaded.DRIFTING_SENTRY_PACKAGED_ACCEPTANCE || '',
    VITE_SENTRY_ENVIRONMENT: loaded.VITE_SENTRY_ENVIRONMENT || 'sentry-acceptance',
  });
  const base = JSON.parse(readFileSync(path.join(worktreeRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  // The installed Tauri code generator emits Vec<u8> for dataStoreIdentifier,
  // while its runtime requires [u8; 16]. Ephemeral WKWebView stores work on all
  // supported macOS versions without changing the product's Rust code.
  const ephemeralWebview = platform === 'darwin' && !buildApp;
  const tauriConfig = {
    identifier,
    productName: `Drifting Test ${profileId}`,
    build: {
      devUrl,
      beforeDevCommand: {
        // Only generated hex characters enter this shell command; the checkout
        // path is supplied as cwd, never interpolated into a shell string.
        script: releasePerf
          ? `pnpm exec vite build ${viteConfigArgument} --outDir ${perfFrontendDirectory} --emptyOutDir && pnpm exec vite preview ${viteConfigArgument} --outDir ${perfFrontendDirectory}`
          : `pnpm exec vite ${viteConfigArgument}`,
        cwd: worktreeRoot,
      },
      ...(buildApp ? { devUrl: null, beforeDevCommand: null, frontendDist: frontendDirectory,
        beforeBuildCommand: { script: `pnpm exec vite build --config .local-data/worktree-dev/${profileId}/vite.config.mjs`, cwd: worktreeRoot } } : {}),
    },
    app: {
      windows: base.app.windows.map(window => ({
        ...window, title: `Drifting Test · ${instance} · ${profileId}`,
        dataDirectory: `worktree-${profileId}`,
        incognito: ephemeralWebview,
      })),
      security: {
        ...(buildApp ? sentrySecurityOverride(hostedSecurityOverride(base, online ? origin : 'http://localhost:3000'), environment) : {}),
        devCsp: (online ? sentrySecurityOverride(hostedSecurityOverride(base, origin), environment).devCsp : base.app.security.devCsp).replace(/\bconnect-src\b[^;]*/, directive =>
          `${directive} ${devUrl} ws://127.0.0.1:${selectedPort}${debugSession ? ` ${debugSession.url}` : ''}`),
      },
    },
    bundle: { createUpdaterArtifacts: false },
    plugins: { 'deep-link': { desktop: { schemes: [`drifting-test-${profileId}`] } } },
  };
  const viteConfigSource = `import { mergeConfig } from 'vite';
import base from '../../../vite.renderer.config.ts';
${performanceAudit ? "import { nativePerformanceAuditPlugin } from '../../../scripts/native-performance-audit-plugin.mjs';" : ''}
export default async env => mergeConfig(await (typeof base === 'function' ? base(env) : base), {
  envDir: false,
  ${performanceAudit ? `plugins: [nativePerformanceAuditPlugin({ directory: ${JSON.stringify(path.join(profileDirectory, 'performance-audit'))}, origin: ${JSON.stringify(devUrl)} })],` : ''}
  cacheDir: ${JSON.stringify(path.join(profileDirectory, 'vite-cache'))},
  server: { host: '127.0.0.1', port: ${selectedPort}, strictPort: true, hmr: true },
  preview: { host: '127.0.0.1', port: ${selectedPort}, strictPort: true }
});
`;
  // This is deliberately a non-secret manifest, not a dump of process.env.
  const manifest = {
    schemaVersion: 1, worktreeRoot, instance, profileId, identifier,
    profileDirectory, databaseDirectory, appLocalDataDirectory, cargoTargetDirectory, devUrl, port: selectedPort,
    keychainService: `Drifting.${identifier}`, agentKeysFromEnv: devAgentKeyProviders(environment), ephemeralWebview,
    mode: online ? 'hosted' : 'local-only', ...(online ? { serviceOrigin: origin } : {}), configPath,
    ...(performanceAudit ? { performanceAudit: true, performanceAuditDirectory: path.join(profileDirectory, 'performance-audit') } : {}),
    ...(debugSession ? { frontendDebug: { transport: debugSession.transport, url: debugSession.url } } : {}),
    ...(releasePerf ? { releasePerf: true } : {}),
    ...(buildApp ? { buildApp: true, frontendDirectory,
      appBundlePath: path.join(cargoTargetDirectory, 'debug', 'bundle', 'macos', `Drifting Test ${profileId}.app`) } : {}),
  };
  return {
    manifest, environment, tauriConfig, viteConfigSource, viteConfigPath,
    command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: ['exec', 'tauri', ...(buildApp ? ['build', '--debug', '--bundles', 'app']
      : ['dev', ...(releasePerf ? ['--release'] : []), ...(noWatch || releasePerf ? ['--no-watch'] : [])]), '--config', configPath],
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
    output('Usage: pnpm dev:worktree [--instance <name>] [--port <number>] [--no-watch] [--performance-audit] [--frontend-debug] [--release-perf] [--online] [--build-app] [--print-config]\nLocal-only by default; --online selects the configured Hosted service in a separate profile. --performance-audit collects bounded development telemetry in the private profile. --frontend-debug connects the renderer to the desktop Frontend Debug daemon running in this checkout. --release-perf runs the same instance as a Rust release build with a production renderer bundle, for performance measurement only. --build-app builds an isolated macOS Debug .app without launching it. --print-config emits JSON without launching or creating files.');
    return;
  }
  const plan = createWorktreePlan({ root, baseEnvironment, ...options });
  if (options.printConfig) { output(JSON.stringify(plan.manifest, null, 2)); return; }
  if (!options.buildApp) await checkPort(plan.manifest.port);
  const signingIdentity = prepareSigning({ command: options.buildApp ? 'build' : 'dev',
    arguments: options.buildApp ? ['--debug'] : [], environment: plan.environment });
  if (options.buildApp && signingIdentity) plan.tauriConfig.bundle.macOS = { signingIdentity };
  mkdirSync(plan.manifest.profileDirectory, { recursive: true, mode: 0o700 });
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
  if (!options.buildApp) output(describeDevAgentKeys(plan.environment));
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
    } catch (error) {
      // An already-exited group: macOS reports EPERM once pnpm reaped it.
      if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
    }
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
