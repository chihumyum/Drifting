#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

import { resolveMacosDevSigningIdentity } from './select-macos-dev-signing-identity.mjs';
import { hostedEnvironment, normalizeHostedOrigin } from './hosted-environment.mjs';
import { sentrySecurityOverride } from './sentry-environment.mjs';
import { describeDevAgentKeys, devAgentKeyEnvironment, devAgentKeyRoots } from './dev-agent-keys.mjs';
import { packageBinInvocation } from './package-bin.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(scriptPath), '..');
const localEnvPath = path.join(repoDir, '.env.local');
const supportedCommands = new Set(['dev', 'build']);

function stringEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry) => typeof entry[1] === 'string'),
  );
}

function readLocalEnvironment(filePath) {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, 'utf8'));
}

export function createDesktopTauriEnvironment({
  baseEnvironment = process.env,
  envFile = localEnvPath,
  mode = 'local',
} = {}) {
  if (mode !== 'local' && mode !== 'online') {
    throw new TypeError(`Unsupported desktop development mode: ${mode}`);
  }

  // Explicit shell/CI values win over ignored local configuration. This is
  // important for release builds while still making `pnpm dev` honor the same
  // `.env.local` that Vite reads.
  const localEnvironment = readLocalEnvironment(envFile);
  const shellEnvironment = stringEnvironment(baseEnvironment);
  const merged = { ...localEnvironment, ...shellEnvironment };
  const environment = {
    ...merged,
    CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER:
      merged.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER ??
      path.join(repoDir, 'scripts', 'run-signed-macos-dev.sh'),
    CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER:
      merged.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER ??
      path.join(repoDir, 'scripts', 'run-signed-macos-dev.sh'),
    DRIFTING_DB_DIR: merged.DRIFTING_DB_DIR || '.local-data/databases',
  };

  if (mode === 'online') {
    return {
      ...environment,
      ...hostedEnvironment(shellEnvironment, localEnvironment),
    };
  }
  return {
    ...environment,
    VITE_LOCAL_ONLY_MODE: 'true',
    VITE_REQUIRE_AUTH: 'false',
    VITE_AI_TRANSPORT: 'direct',
    VITE_API_BASE_URL: 'http://localhost:3000',
    API_BASE_URL: 'http://localhost:3000',
  };
}

/**
 * The daily development App keeps its app-local folder (assets, sync objects,
 * installation identity) beside its database, never in the installed App's
 * folder, so a development build and a release never share an identity.
 */
export function developmentAppDataDirectory(command, environment) {
  if (environment.DRIFTING_APP_DATA_DIR) return environment.DRIFTING_APP_DATA_DIR;
  return command === 'dev' ? '.local-data/app-data' : undefined;
}

/** Matches the code-signing identifier the development runner signs with. */
export const DEVELOPMENT_IDENTIFIER = 'cc.drifting.client.dev';

/**
 * The daily development App runs under its own identifier, so the installed
 * release's single-instance check does not hand its launch to the development
 * window (and the reverse). Keychain items stay shared; see secure_storage.rs.
 */
export function withDevelopmentIdentifier(command, override) {
  if (command !== 'dev') return override;
  return { ...(override ?? {}), identifier: DEVELOPMENT_IDENTIFIER };
}

/** Check before Cargo/Vite starts, so a new contributor sees setup guidance
 * without first compiling the native host. The runner rechecks before launch. */
export function prepareDesktopSigning({ command, arguments: tauriArguments = [], environment,
  platform = process.platform, resolveIdentity = resolveMacosDevSigningIdentity }) {
  if (platform !== 'darwin' || tauriArguments.includes('--help') || tauriArguments.includes('-h')) return undefined;
  const debug = tauriArguments.includes('--debug') || tauriArguments.includes('-d');
  const localBuild = command === 'build' && (debug || !environment.DRIFTING_UPDATER_PUBLIC_KEY?.trim());
  if (command !== 'dev' && !localBuild) return undefined;
  try {
    const identity = resolveIdentity({ requestedIdentity: environment.DRIFTING_MACOS_DEV_SIGNING_IDENTITY });
    if (command === 'dev') environment.DRIFTING_MACOS_DEV_SIGNING_IDENTITY = identity;
    return identity;
  } catch (error) {
    throw new Error(`${error.message}\n\nmacOS setup: open Xcode Settings > Apple Accounts, select your own team,\n`
      + 'then Manage Certificates > + > Apple Development. Keep its private key on this Mac.\n'
      + 'Run pnpm dev:check after setup. For missing/revoked certificates or OCSP failures,\n'
      + 'see docs/contributor-quick-start.md. No maintainer certificate or service account is required.');
  }
}

export function createDesktopTauriConfigOverride({
  command,
  arguments: tauriArguments = [],
  environment,
  macosSigningIdentity,
}) {
  const override = {};
  if (environment.VITE_LOCAL_ONLY_MODE === 'false') {
    const origin = normalizeHostedOrigin(environment.DRIFTING_HOSTED_ORIGIN);
    const config = JSON.parse(readFileSync(path.join(repoDir, 'src-tauri/tauri.conf.json'), 'utf8'));
    const addOrigin = (csp) => csp.replace(/\bconnect-src\b[^;]*/, (directive) =>
      directive.split(/\s+/).includes(origin) ? directive : `${directive} ${origin}`);
    override.app = { security: sentrySecurityOverride({
      csp: addOrigin(config.app.security.csp),
      devCsp: addOrigin(config.app.security.devCsp),
    }, environment) };
  }
  if (command !== 'build') return Object.keys(override).length ? override : null;

  const debug = tauriArguments.includes('--debug') || tauriArguments.includes('-d');
  const updaterPublicKey = environment.DRIFTING_UPDATER_PUBLIC_KEY?.trim();
  // The key remains an environment-owned release input. Whenever it is set,
  // Cargo compiles it in and the App starts the updater plugin
  // (app_update.rs), which needs this plugin configuration as well; the
  // bundler needs it too when it signs updater artifacts.
  const updater = updaterPublicKey ? { plugins: { updater: { pubkey: updaterPublicKey } } } : {};
  // Preview builds (docs/windows.md) compile the public key in, so they can
  // update to a published release, but sign no updater artifacts of their own.
  if (debug || !updaterPublicKey || environment.DRIFTING_UPDATER_ARTIFACTS === 'off') {
    return {
      ...override,
      ...updater,
      bundle: {
        createUpdaterArtifacts: false,
        ...(macosSigningIdentity
          ? { macOS: { signingIdentity: macosSigningIdentity } }
          : {}),
      },
    };
  }

  return { ...override, ...updater };
}

/**
 * Whether `directory` is a linked Git worktree rather than the main checkout.
 * Outside Git, or when Git cannot tell, it is treated as the main checkout.
 */
export function isLinkedGitWorktree(directory = repoDir, run = spawnSync) {
  const result = run('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return false;
  const [gitDirectory, commonDirectory] = result.stdout.trim().split(/\r?\n/u);
  return Boolean(gitDirectory && commonDirectory) && path.resolve(gitDirectory) !== path.resolve(commonDirectory);
}

/**
 * `pnpm dev` in a linked worktree uses that worktree's isolated profile
 * (docs/worktree-development.md): the shared profile's identity, port and
 * application data belong to the main checkout. DRIFTING_DEV_SHARED_PROFILE=1
 * keeps the shared profile.
 */
export function shouldIsolateDevelopment({ command, environment = process.env, linked = isLinkedGitWorktree } = {}) {
  return command === 'dev' && environment.DRIFTING_DEV_SHARED_PROFILE !== '1' && linked();
}

function writeTemporaryTauriConfig(configuration) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-tauri-config-'));
  const filePath = path.join(directory, 'tauri.override.json');
  writeFileSync(filePath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  return { directory, filePath };
}

/**
 * How the Tauri CLI is started. Elsewhere through `pnpm exec`; on Windows Node
 * refuses to spawn `pnpm.cmd` without a shell (EINVAL), and a shell would
 * re-split paths with spaces, so Node runs the CLI's own entry script
 * (scripts/package-bin.mjs).
 */
export function tauriCliInvocation({ platform = process.platform, nodeExecutable = process.execPath, root = repoDir } = {}) {
  if (platform === 'win32') return packageBinInvocation('tauri', { root, platform, nodeExecutable });
  return { executable: 'pnpm', arguments: ['--dir', root, 'exec', 'tauri'] };
}

export async function runDesktopTauri(rawArguments = process.argv.slice(2)) {
  const [command, ...forwarded] = rawArguments;
  if (!supportedCommands.has(command)) {
    throw new Error('Usage: node scripts/run-desktop-tauri.mjs <dev|build> [--online] [options]');
  }
  // pnpm preserves its argument-separator marker. It is not a Tauri runner
  // separator, so remove only that leading marker before forwarding options.
  const normalizedForwarded = forwarded[0] === '--' ? forwarded.slice(1) : forwarded;
  if (shouldIsolateDevelopment({ command })) {
    console.log('Linked Git worktree: starting its isolated development profile (pnpm dev:worktree). '
      + 'Set DRIFTING_DEV_SHARED_PROFILE=1 to use the shared profile instead.');
    const { runWorktreeDev } = await import('./run-worktree-dev.mjs');
    await runWorktreeDev(normalizedForwarded);
    return;
  }
  const online = normalizedForwarded.includes('--online');
  const tauriArguments = normalizedForwarded.filter((argument) => argument !== '--online');
  const environment = createDesktopTauriEnvironment({ mode: online ? 'online' : 'local' });
  const appDataDirectory = developmentAppDataDirectory(command, environment);
  if (appDataDirectory) environment.DRIFTING_APP_DATA_DIR = appDataDirectory;
  // Development only: the Agent's keys from .env (scripts/dev-agent-keys.mjs).
  if (command === 'dev') {
    Object.assign(environment, devAgentKeyEnvironment({ roots: devAgentKeyRoots(repoDir), baseEnvironment: environment }));
    console.log(describeDevAgentKeys(environment));
  }
  const macosSigningIdentity = prepareDesktopSigning({ command, arguments: tauriArguments, environment });
  const tauriConfigOverride = withDevelopmentIdentifier(command, createDesktopTauriConfigOverride({
    command,
    arguments: tauriArguments,
    environment,
    macosSigningIdentity,
  }));

  console.log(online
    ? `Hosted service: ${environment.DRIFTING_HOSTED_ORIGIN}`
    : 'Local-only client: Hosted service disabled');


  if (command === 'build') {
    console.log(
      tauriConfigOverride?.plugins?.updater && tauriConfigOverride.bundle?.createUpdaterArtifacts !== false
        ? 'Signed updater artifacts: configured for this release build'
        : 'Signed updater artifacts: disabled for this local/debug build',
    );
    if (macosSigningIdentity) {
      console.log('Local macOS bundle signing: Apple Development identity configured');
    }
  }

  const temporaryConfig = tauriConfigOverride
    ? writeTemporaryTauriConfig(tauriConfigOverride)
    : null;
  const effectiveArguments = temporaryConfig
    ? [...tauriArguments, '--config', temporaryConfig.filePath]
    : tauriArguments;
  let exitSignal = null;

  try {
    const cli = tauriCliInvocation();
    const child = spawn(
      cli.executable,
      [...cli.arguments, command, ...effectiveArguments],
      {
        cwd: repoDir,
        env: environment,
        stdio: 'inherit',
      },
    );

    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (signal) {
          exitSignal = signal;
          resolve();
          return;
        }
        if (code === 0) resolve();
        else reject(new Error(`Tauri ${command} exited with code ${code ?? 'unknown'}`));
      });
    });
  } finally {
    if (temporaryConfig) rmSync(temporaryConfig.directory, { recursive: true, force: true });
  }
  if (exitSignal) process.kill(process.pid, exitSignal);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runDesktopTauri().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
