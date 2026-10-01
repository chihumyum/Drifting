#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { hostedSecurityOverride } from './hosted-environment.mjs';
import { discoverIosDevices, selectIosDevice } from './ios-device-selection.mjs';

import {
  createMobileEnvironment,
  writeIosGoogleOauthLocalConfig,
} from './run-mobile-dev.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(scriptPath), '..');
const bundleIdentifier = 'cc.drifting.client';

export const IOS_DEVICE_DEBUG_USAGE = [
  'Usage: pnpm mobile:ios:device:debug -- --device <name-or-id> [--no-launch] [--online]',
  '',
  'The device may also be supplied through DRIFTING_IOS_DEVICE.',
].join('\n');

export const IOS_DEVICE_RELEASE_USAGE = [
  'Usage: pnpm mobile:ios:device:release -- [--device <name-or-id>] [--no-launch] [--online]',
  '',
  'Build, verify, install and launch a signed arm64 Release app (no dev server).',
  'One available paired iPhone/iPad is selected automatically; multiple devices prompt in the terminal.',
  'Use --device or DRIFTING_IOS_DEVICE for non-interactive runs. Enter q to cancel selection.',
  'Local-only by default. --online requires an HTTPS DRIFTING_HOSTED_ORIGIN.',
].join('\n');

export function parseIosDeviceArguments(
  rawArguments,
  environment = process.env,
  profile = 'debug',
) {
  const argumentsWithoutSeparator =
    rawArguments[0] === '--' ? rawArguments.slice(1) : [...rawArguments];
  let device = environment.DRIFTING_IOS_DEVICE?.trim() || '';
  let launch = true;
  let help = false;
  let online = false;

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
    if (argument === '--online') { online = true; continue; }
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

  if (!help && !device && profile === 'debug') {
    throw new Error(
      'A paired iOS device is required. Pass --device <name-or-id> or set DRIFTING_IOS_DEVICE.',
    );
  }

  return Object.freeze({ device, launch, help, ...(online ? { online } : {}) });
}

export function createIosDevicePlan({
  device,
  profile = 'debug',
  launch = true,
  root = repoDir,
  pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
} = {}) {
  if (!['debug', 'release'].includes(profile)) throw new Error(`Unsupported build profile: ${profile}`);
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
        ...(profile === 'debug' ? ['--debug'] : []),
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
    child.once('close', (code, signal) => {
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

export async function installIosDevice(
  rawArguments = process.argv.slice(2),
  {
    baseEnvironment = process.env,
    platform = process.platform,
    pathExists = existsSync,
    execute = runCommand,
    createEnvironment = createMobileEnvironment,
    writeOauthConfiguration = writeIosGoogleOauthLocalConfig,
    profile = 'debug',
    discoverDevices = discoverIosDevices,
    selectDevice = selectIosDevice,
  } = {},
) {
  const options = parseIosDeviceArguments(rawArguments, baseEnvironment, profile);
  if (options.help) {
    console.log(profile === 'release' ? IOS_DEVICE_RELEASE_USAGE : IOS_DEVICE_DEBUG_USAGE);
    return;
  }
  if (platform !== 'darwin') {
    throw new Error('Standalone iOS device builds require macOS and Xcode.');
  }

  const environment = createEnvironment('ios', {
    mode: options.online ? 'online' : 'local',
    baseEnvironment: {
      ...baseEnvironment,
      ...(options.online ? {} : {
      VITE_LOCAL_ONLY_MODE: 'true',
      VITE_REQUIRE_AUTH: 'false',
      VITE_AI_TRANSPORT: 'direct',
      VITE_API_BASE_URL: 'http://localhost:3000',
      API_BASE_URL: 'http://localhost:3000',
      }),
    },
  });
  if (profile === 'release' && options.online
    && !environment.DRIFTING_HOSTED_ORIGIN?.startsWith('https://')) {
    throw new Error('Release Hosted clients require an HTTPS DRIFTING_HOSTED_ORIGIN.');
  }
  const device = profile === 'release'
    ? await selectDevice(await discoverDevices(execute, environment), { requested: options.device })
    : options.device;
  if (profile === 'release') {
    environment.SDKROOT = String(await execute('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], {
      environment, captureOutput: true,
    })).trim();
    environment.PATH = `${path.join(repoDir, 'scripts/apple-toolchain')}${path.delimiter}${environment.PATH ?? ''}`;
    // Keep the private signing team in the environment / ignored xcconfig.
    const team = (environment.APPLE_DEVELOPMENT_TEAM || environment.DRIFTING_APPLE_DEVELOPMENT_TEAM || '').trim();
    if (!/^[A-Z0-9]{10}$/u.test(team)) {
      throw new Error('Configure a valid DRIFTING_APPLE_DEVELOPMENT_TEAM in the shell or ignored .env.local before building for a physical device.');
    }
    environment.APPLE_DEVELOPMENT_TEAM = team;
    environment.DRIFTING_APPLE_DEVELOPMENT_TEAM = team;
  }
  const oauth = writeOauthConfiguration(environment);
  console.log(`Building standalone iOS arm64 ${profile === 'release' ? 'Release' : 'Debug'} archive in ${options.online ? 'Hosted' : 'local-only'} mode.`);
  console.log(
    oauth.googleDriveOAuthConfigured
      ? 'Google Drive iOS OAuth build configuration: configured'
      : 'Google Drive iOS OAuth build configuration: missing or invalid',
  );

  const plan = createIosDevicePlan({
    device,
    profile,
    launch: options.launch,
  });
  const buildArguments = [...plan.build.arguments];
  if (options.online) {
    const config = JSON.parse(readFileSync(path.join(repoDir, 'src-tauri/tauri.conf.json'), 'utf8'));
    buildArguments.push('--config', JSON.stringify({ app: { security: hostedSecurityOverride(config, environment.DRIFTING_HOSTED_ORIGIN) } }));
  }
  await execute(plan.build.command, buildArguments, { environment });
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
    `Installed ${bundleIdentifier} on ${device}${options.launch ? ' and launched it' : ''}.`,
  );
  console.log('The existing app was updated in place; this command did not uninstall or reset its data.');
}
