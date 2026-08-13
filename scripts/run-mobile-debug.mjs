#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scriptPath = fileURLToPath(import.meta.url);
const coreDir = path.resolve(path.dirname(scriptPath), '..');
const repoDir = coreDir;
const target = process.argv[2];
const supportedTargets = new Set(['ios', 'android']);
const execFileAsync = promisify(execFile);

async function resolveTauriDeviceName(platform, deviceId) {
  if (!deviceId) return undefined;
  if (platform === 'ios') {
    const { stdout } = await execFileAsync(
      'xcrun',
      ['simctl', 'list', 'devices', 'available', '-j'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const parsed = JSON.parse(stdout);
    const match = Object.values(parsed.devices ?? {})
      .flat()
      .find((device) => device.udid === deviceId);
    if (!match?.name) throw new Error(`iOS Simulator ${deviceId} is unavailable`);
    return match.name;
  }
  try {
    const { stdout } = await execFileAsync('adb', ['-s', deviceId, 'emu', 'avd', 'name'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return (
      stdout
        .split(/\r?\n/u)
        .find((line) => line.trim() && line.trim() !== 'OK')
        ?.trim() ?? deviceId
    );
  } catch {
    return deviceId;
  }
}

if (!supportedTargets.has(target)) {
  console.error('Usage: node scripts/run-mobile-debug.mjs <ios|android> [--device <id>]');
  process.exitCode = 2;
} else {
  const rawArgs = process.argv.slice(3);
  const forwardedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const deviceAt = forwardedArgs.indexOf('--device');
  const deviceId = deviceAt >= 0 ? forwardedArgs[deviceAt + 1] : undefined;
  if (deviceAt >= 0 && !deviceId) {
    console.error('--device requires a simulator identifier');
    process.exitCode = 2;
  } else {
    const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const daemonArgs = [
      '--dir',
      coreDir,
      'dev:cli',
      'frontend',
      'serve',
      '--platform',
      target,
      ...(deviceId ? ['--device', deviceId] : []),
    ];
    const daemon = spawn(pnpmExecutable, daemonArgs, {
      cwd: repoDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffered = '';
    let settled = false;
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Frontend debug daemon did not start within 20 seconds')),
        20_000,
      );
      daemon.stdout.setEncoding('utf8');
      daemon.stdout.on('data', (chunk) => {
        buffered += chunk;
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
          if (!line.startsWith('{')) continue;
          try {
            const envelope = JSON.parse(line);
            if (!envelope.ok) {
              clearTimeout(timeout);
              reject(new Error(envelope.error?.message ?? 'Frontend debug daemon failed'));
              return;
            }
            if (envelope.command === 'frontend serve') {
              clearTimeout(timeout);
              resolve(envelope.data);
              return;
            }
          } catch {
            // pnpm may print non-JSON lifecycle output before the CLI envelope.
          }
        }
      });
      daemon.once('exit', (code) => {
        if (!settled) reject(new Error(`Frontend debug daemon exited with code ${code ?? 1}`));
      });
      daemon.once('error', reject);
    });

    const cleanup = () => {
      if (!daemon.killed) daemon.kill('SIGTERM');
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    try {
      const data = await ready;
      settled = true;
      const rendererEnv = data?.result?.rendererEnv;
      if (!rendererEnv || typeof rendererEnv !== 'object') {
        throw new Error('Frontend debug daemon did not return renderer environment');
      }
      console.log(`Frontend debug ready: ${data.transport} (${data.runId})`);
      const tauriDevice = await resolveTauriDeviceName(target, deviceId);
      const tauriArgs =
        deviceAt >= 0
          ? forwardedArgs.filter((_, index) => index !== deviceAt && index !== deviceAt + 1)
          : forwardedArgs;
      const mobile = spawn(
        process.execPath,
        [
          path.join(coreDir, 'scripts', 'run-mobile-dev.mjs'),
          target,
          ...(tauriDevice ? [tauriDevice] : []),
          ...tauriArgs,
        ],
        {
          cwd: repoDir,
          env: { ...process.env, ...rendererEnv },
          stdio: 'inherit',
        },
      );
      const code = await new Promise((resolve, reject) => {
        mobile.once('exit', (exitCode) => resolve(exitCode ?? 1));
        mobile.once('error', reject);
      });
      cleanup();
      process.exitCode = code;
    } catch (error) {
      settled = true;
      cleanup();
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
