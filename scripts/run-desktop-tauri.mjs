#!/usr/bin/env node

import { spawn } from 'node:child_process';
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
  const merged = {
    ...readLocalEnvironment(envFile),
    ...stringEnvironment(baseEnvironment),
  };
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
      VITE_LOCAL_ONLY_MODE: 'false',
      VITE_REQUIRE_AUTH: 'true',
      VITE_AI_TRANSPORT: 'proxy',
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

export function describeDesktopOauthConfiguration(environment) {
  return Object.freeze({
    googleDriveOAuthConfigured: Boolean(
      environment.DRIFTING_GOOGLE_DESKTOP_CLIENT_ID?.trim(),
    ),
  });
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
  if (command !== 'build') return null;

  const debug = tauriArguments.includes('--debug') || tauriArguments.includes('-d');
  const updaterPublicKey = environment.DRIFTING_UPDATER_PUBLIC_KEY?.trim();
  if (debug || !updaterPublicKey) {
    return {
      bundle: {
        createUpdaterArtifacts: false,
        ...(macosSigningIdentity
          ? { macOS: { signingIdentity: macosSigningIdentity } }
          : {}),
      },
    };
  }

  // The key remains an environment-owned release input. Tauri's bundler also
  // needs it in plugin configuration when createUpdaterArtifacts is enabled.
  return { plugins: { updater: { pubkey: updaterPublicKey } } };
}

function writeTemporaryTauriConfig(configuration) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drifting-tauri-config-'));
  const filePath = path.join(directory, 'tauri.override.json');
  writeFileSync(filePath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  return { directory, filePath };
}

export async function runDesktopTauri(rawArguments = process.argv.slice(2)) {
  const [command, ...forwarded] = rawArguments;
  if (!supportedCommands.has(command)) {
    throw new Error('Usage: node scripts/run-desktop-tauri.mjs <dev|build> [--online] [options]');
  }
  // pnpm preserves its argument-separator marker. It is not a Tauri runner
  // separator, so remove only that leading marker before forwarding options.
  const normalizedForwarded = forwarded[0] === '--' ? forwarded.slice(1) : forwarded;
  const online = normalizedForwarded.includes('--online');
  const tauriArguments = normalizedForwarded.filter((argument) => argument !== '--online');
  const environment = createDesktopTauriEnvironment({ mode: online ? 'online' : 'local' });
  const configuration = describeDesktopOauthConfiguration(environment);
  const macosSigningIdentity = prepareDesktopSigning({ command, arguments: tauriArguments, environment });
  const tauriConfigOverride = createDesktopTauriConfigOverride({
    command,
    arguments: tauriArguments,
    environment,
    macosSigningIdentity,
  });

  console.log(
    configuration.googleDriveOAuthConfigured
      ? 'Google Drive desktop OAuth build configuration: configured'
      : 'Google Drive desktop OAuth build configuration: missing (.env.local or shell environment)',
  );

  if (command === 'build') {
    console.log(
      tauriConfigOverride?.plugins?.updater
        ? 'Signed updater artifacts: configured for this release build'
        : 'Signed updater artifacts: disabled for this local/debug build',
    );
    if (macosSigningIdentity) {
      console.log('Local macOS bundle signing: Apple Development identity configured');
    }
  }

  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const temporaryConfig = tauriConfigOverride
    ? writeTemporaryTauriConfig(tauriConfigOverride)
    : null;
  const effectiveArguments = temporaryConfig
    ? [...tauriArguments, '--config', temporaryConfig.filePath]
    : tauriArguments;
  let exitSignal = null;

  try {
    const child = spawn(
      pnpmExecutable,
      ['--dir', repoDir, 'exec', 'tauri', command, ...effectiveArguments],
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
