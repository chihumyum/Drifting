#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createMobileEnvironment,
  writeIosGoogleOauthLocalConfig,
} from './run-mobile-dev.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(scriptPath), '..');
const bundleIdentifier = 'cc.drifting.client';

export const IOS_DEVICE_DEBUG_USAGE = [
  'Usage: pnpm mobile:ios:device:debug -- --device <name-or-id> [--no-launch]',
  '',
  'The device may also be supplied through DRIFTING_IOS_DEVICE.',
].join('\n');

export function parseIosDeviceDebugArguments(
  rawArguments,
  environment = process.env,
) {
  const argumentsWithoutSeparator =
    rawArguments[0] === '--' ? rawArguments.slice(1) : [...rawArguments];
  let device = environment.DRIFTING_IOS_DEVICE?.trim() || '';
  let launch = true;
  let help = false;

  for (let index = 0; index < argumentsWithoutSeparator.length; index += 1) {
    const argument = argumentsWithoutSeparator[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--no-launch') {
      launch = false;
      continue;
    }
    if (argument === '--device' || argument === '-d') {
      const value = argumentsWithoutSeparator[index + 1]?.trim();
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a device name or identifier.`);
      }
      device = value;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported option: ${argument}`);
  }

  if (!help && !device) {
    throw new Error(
      'A paired iOS device is required. Pass --device <name-or-id> or set DRIFTING_IOS_DEVICE.',
    );
  }

  return Object.freeze({ device, launch, help });
}

export function createIosDeviceDebugPlan({
  device,
  launch = true,
  root = repoDir,
  pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
} = {}) {
  if (!device?.trim()) throw new Error('A paired iOS device is required.');
  const appPath = path.join(
    root,
    'src-tauri',
    'gen',
    'apple',
    'build',
    'drifting_iOS.xcarchive',
    'Products',
    'Applications',
    'Drifting.app',
  );
  const infoPlistPath = path.join(appPath, 'Info.plist');

  return Object.freeze({
    appPath,
    build: Object.freeze({
      command: pnpmExecutable,
      arguments: Object.freeze([
        '--dir',
        root,
        'exec',
        'tauri',
        'ios',
        'build',
        '--debug',
        '--target',
        'aarch64',
        '--archive-only',
        '--ci',
      ]),
    }),
    verifySignature: Object.freeze({
      command: '/usr/bin/codesign',
      arguments: Object.freeze(['--verify', '--deep', '--strict', appPath]),
    }),
    readBundleIdentifier: Object.freeze({
      command: '/usr/bin/plutil',
      arguments: Object.freeze([
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        infoPlistPath,
      ]),
    }),
    install: Object.freeze({
      command: 'xcrun',
      arguments: Object.freeze([
        'devicectl',
        'device',
        'install',
        'app',
        '--device',
        device,
        appPath,
      ]),
    }),
    launch: launch
      ? Object.freeze({
          command: 'xcrun',
          arguments: Object.freeze([
            'devicectl',
            'device',
            'process',
            'launch',
            '--device',
            device,
            '--terminate-existing',
            bundleIdentifier,
          ]),
        })
      : null,
  });
}

function runCommand(command, args, { environment, captureOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoDir,
      env: environment,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (captureOutput) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = captureOutput ? stderr.trim() : '';
      reject(
        new Error(
          detail ||
            `${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}.`,
        ),
      );
    });
  });
}

export async function installIosDebugDevice(
  rawArguments = process.argv.slice(2),
  {
    baseEnvironment = process.env,
    platform = process.platform,
    pathExists = existsSync,
    execute = runCommand,
    createEnvironment = createMobileEnvironment,
    writeOauthConfiguration = writeIosGoogleOauthLocalConfig,
  } = {},
) {
  const options = parseIosDeviceDebugArguments(rawArguments, baseEnvironment);
  if (options.help) {
    console.log(IOS_DEVICE_DEBUG_USAGE);
    return;
  }
  if (platform !== 'darwin') {
    throw new Error('Standalone iOS device builds require macOS and Xcode.');
  }

  const environment = createEnvironment('ios', {
    baseEnvironment: {
      ...baseEnvironment,
      VITE_LOCAL_ONLY_MODE: 'true',
      VITE_REQUIRE_AUTH: 'false',
      VITE_AI_TRANSPORT: 'direct',
      VITE_API_BASE_URL: 'http://localhost:3000',
      API_BASE_URL: 'http://localhost:3000',
    },
  });
  const oauth = writeOauthConfiguration(environment);
  console.log('Building standalone iOS arm64 Debug archive in local-only mode.');
  console.log(
    oauth.googleDriveOAuthConfigured
      ? 'Google Drive iOS OAuth build configuration: configured'
      : 'Google Drive iOS OAuth build configuration: missing or invalid',
  );

  const plan = createIosDeviceDebugPlan({
    device: options.device,
    launch: options.launch,
  });
  await execute(plan.build.command, plan.build.arguments, { environment });
  if (!pathExists(plan.appPath)) {
    throw new Error(`Tauri completed without producing the expected app bundle: ${plan.appPath}`);
  }
  await execute(plan.verifySignature.command, plan.verifySignature.arguments, { environment });
  const actualBundleIdentifier = String(
    await execute(plan.readBundleIdentifier.command, plan.readBundleIdentifier.arguments, {
      environment,
      captureOutput: true,
    }),
  ).trim();
  if (actualBundleIdentifier !== bundleIdentifier) {
    throw new Error(`Refusing to install unexpected bundle identifier: ${actualBundleIdentifier}`);
  }
  await execute(plan.install.command, plan.install.arguments, { environment });
  if (plan.launch) {
    await execute(plan.launch.command, plan.launch.arguments, { environment });
  }

  console.log(
    `Installed ${bundleIdentifier} on ${options.device}${options.launch ? ' and launched it' : ''}.`,
  );
  console.log('The existing app was updated in place; this command did not uninstall or reset its data.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  installIosDebugDevice().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error(IOS_DEVICE_DEBUG_USAGE);
    process.exitCode = 1;
  });
}
