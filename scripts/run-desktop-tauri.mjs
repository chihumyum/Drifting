#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

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

  console.log(
    configuration.googleDriveOAuthConfigured
      ? 'Google Drive desktop OAuth build configuration: configured'
      : 'Google Drive desktop OAuth build configuration: missing (.env.local or shell environment)',
  );

  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(
    pnpmExecutable,
    ['--dir', repoDir, 'exec', 'tauri', command, ...tauriArguments],
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
        process.kill(process.pid, signal);
        resolve();
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`Tauri ${command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runDesktopTauri().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
