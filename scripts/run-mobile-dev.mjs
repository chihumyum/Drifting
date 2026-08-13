#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const coreDir = path.resolve(path.dirname(scriptPath), '..');
const repoDir = coreDir;
const supportedTargets = new Set(['ios', 'android']);

function isPrivateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function findLanIpv4() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (address) =>
          (address.family === 'IPv4' || address.family === 4) &&
          !address.internal &&
          !address.address.startsWith('169.254.'),
      )
      .map((address) => ({ name, address: address.address })),
  );

  candidates.sort((left, right) => {
    const score = (candidate) => {
      if (/^(utun|awdl|llw|bridge|docker|vbox)/.test(candidate.name)) return -100;
      if (candidate.name === 'en0' && isPrivateIpv4(candidate.address)) return 300;
      if (/^en\d+$/.test(candidate.name) && isPrivateIpv4(candidate.address)) return 200;
      return isPrivateIpv4(candidate.address) ? 100 : 0;
    };
    return score(right) - score(left);
  });

  return candidates[0]?.address;
}

function resolveApiBaseUrl() {
  const explicitApiBaseUrl = process.env.VITE_API_BASE_URL ?? process.env.API_BASE_URL;
  if (explicitApiBaseUrl) return explicitApiBaseUrl.replace(/\/$/, '');

  const lanAddress = findLanIpv4();
  return lanAddress ? `http://${lanAddress}:3000` : 'http://localhost:3000';
}

function createDevConfigOverride(apiBaseUrl, vitePort) {
  const configPath = path.join(coreDir, 'src-tauri', 'tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const devCsp = config.app?.security?.devCsp;
  const apiOrigin = new URL(apiBaseUrl).origin;

  if (typeof devCsp !== 'string') {
    throw new Error('Expected app.security.devCsp in src-tauri/tauri.conf.json.');
  }

  const localDevCsp = devCsp.includes(apiOrigin)
    ? devCsp
    : devCsp.replace(/\bconnect-src\b[^;]*/, (directive) => `${directive} ${apiOrigin}`);

  return JSON.stringify({
    build: { devUrl: `http://localhost:${vitePort}` },
    app: { security: { devCsp: localDevCsp } },
  });
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailableVitePort() {
  const hosts = [...new Set(['127.0.0.1', '::1', findLanIpv4()].filter(Boolean))];
  for (let port = 5173; port <= 5193; port += 1) {
    const availability = await Promise.all(hosts.map((host) => isPortAvailable(port, host)));
    if (availability.every(Boolean)) return port;
  }
  throw new Error('No free Vite port found in the 5173-5193 range.');
}

function findAndroidNdk(env) {
  const explicitCandidates = [env.NDK_HOME, env.ANDROID_NDK_HOME].filter(Boolean);
  for (const candidate of explicitCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const sdkRoots = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    path.join(homedir(), 'Library', 'Android', 'sdk'),
  ].filter(Boolean);

  for (const sdkRoot of sdkRoots) {
    const ndkRoot = path.join(sdkRoot, 'ndk');
    if (!existsSync(ndkRoot)) continue;

    const versions = readdirSync(ndkRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(path.join(ndkRoot, entry.name, 'source.properties')),
      )
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

    if (versions[0]) return path.join(ndkRoot, versions[0]);
  }

  return undefined;
}

function mobileEnvironment(target) {
  const apiBaseUrl = resolveApiBaseUrl();
  const localOnly = (process.env.VITE_LOCAL_ONLY_MODE ?? 'true') !== 'false';
  const env = {
    ...process.env,
    VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? apiBaseUrl,
    API_BASE_URL: process.env.API_BASE_URL ?? apiBaseUrl,
    VITE_LOCAL_ONLY_MODE: String(localOnly),
    VITE_ENABLE_SYNC: process.env.VITE_ENABLE_SYNC ?? (localOnly ? 'false' : 'true'),
    VITE_REQUIRE_AUTH: process.env.VITE_REQUIRE_AUTH ?? (localOnly ? 'false' : 'true'),
    VITE_AI_TRANSPORT: process.env.VITE_AI_TRANSPORT ?? (localOnly ? 'direct' : 'proxy'),
    VITE_CLOSED_BETA: process.env.VITE_CLOSED_BETA ?? 'false',
  };

  if (target === 'android') {
    const ndkHome = findAndroidNdk(env);
    if (!ndkHome) {
      throw new Error(
        'Android NDK not found. Install it in Android Studio, or set NDK_HOME/ANDROID_NDK_HOME.',
      );
    }
    env.NDK_HOME = ndkHome;
  }

  return env;
}

async function assertServiceReachable(apiBaseUrl) {
  let response;
  try {
    response = await fetch(new URL('/', apiBaseUrl), {
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    throw new Error(
      `Cannot reach the configured service at ${apiBaseUrl}. Start it separately or use the default local-only mode.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Configured service preflight failed at ${apiBaseUrl} with HTTP ${response.status}.`,
    );
  }
}

async function run() {
  const target = process.argv[2];
  if (!supportedTargets.has(target)) {
    console.error('Usage: node scripts/run-mobile-dev.mjs <ios|android> [device/options]');
    process.exitCode = 2;
    return;
  }

  let env;
  try {
    env = mobileEnvironment(target);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const rawForwardedArgs = process.argv.slice(3);
  // pnpm 10 preserves the first `--` used to separate script arguments. It is
  // not a Tauri runner separator, so remove only that leading marker.
  const forwardedArgs = rawForwardedArgs[0] === '--' ? rawForwardedArgs.slice(1) : rawForwardedArgs;
  const informationOnly = forwardedArgs.some((arg) =>
    ['-h', '--help', '-V', '--version'].includes(arg),
  );
  if (!informationOnly && env.VITE_LOCAL_ONLY_MODE === 'false') {
    try {
      await assertServiceReachable(env.VITE_API_BASE_URL);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }
  }

  let vitePort = 5173;
  if (!informationOnly) {
    try {
      vitePort = await findAvailableVitePort();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }
  }
  env.DRIFTING_VITE_PORT = String(vitePort);

  const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const devConfig = createDevConfigOverride(env.VITE_API_BASE_URL, vitePort);
  const args = ['--dir', coreDir, 'tauri', target, 'dev', '--config', devConfig, ...forwardedArgs];

  console.log(
    env.VITE_LOCAL_ONLY_MODE === 'true'
      ? `Starting ${target} dev build in local-only mode`
      : `Starting ${target} dev build with configured service ${env.VITE_API_BASE_URL}`,
  );
  console.log(`Using Vite dev port ${vitePort}`);
  if (target === 'android') console.log(`Using Android NDK ${env.NDK_HOME}`);
  if (forwardedArgs.length === 0) {
    console.log('No target supplied; Tauri will use a connected device or prompt for a simulator.');
  }

  const child = spawn(pnpmExecutable, args, {
    cwd: repoDir,
    env,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error(`Unable to start pnpm: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

void run();
