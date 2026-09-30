#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveMacosDevSigningIdentity } from './select-macos-dev-signing-identity.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target = 'desktop', command = 'dev', ...args] = process.argv.slice(2);
if (!['desktop', 'ios', 'android'].includes(target) || !['dev', 'build'].includes(command))
  throw new Error('Usage: hosted:client <desktop|ios|android> <dev|build> [Tauri options]');
const peer = process.env.DRIFTING_HOSTED_LAB_INSTANCE === 'peer';
const labIdentifier = `cc.drifting.client.hosted-lab${peer ? '.peer' : ''}`;
const labName = peer ? 'Drifting Hosted Peer' : 'Drifting Hosted Lab';
const origin = new URL(process.env.DRIFTING_HOSTED_ORIGIN ?? 'http://localhost:3000').origin;
if (command === 'build' && !args.includes('--debug') && !origin.startsWith('https://'))
  throw new Error('Release Hosted clients require an HTTPS DRIFTING_HOSTED_ORIGIN.');
const config = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const addOrigin = (value) =>
  value.replace(/\bconnect-src\b[^;]*/, (directive) => `${directive} ${origin}`);
const override = {
  identifier: labIdentifier,
  productName: labName,
  app: {
    security: {
      csp: addOrigin(config.app.security.csp),
      devCsp: addOrigin(config.app.security.devCsp),
    },
  },
  bundle: {
    createUpdaterArtifacts: false,
    ...(target === 'desktop' && command === 'build' && process.platform === 'darwin'
      ? {
          macOS: {
            signingIdentity: args.includes('--debug')
              ? '-'
              : resolveMacosDevSigningIdentity({
                  requestedIdentity: process.env.DRIFTING_MACOS_DEV_SIGNING_IDENTITY,
                }),
          },
        }
      : {}),
  },
};
const iosInfo = path.join(root, 'src-tauri/gen/apple/drifting_iOS/Info.plist');
const originalInfo = target === 'ios' ? readFileSync(iosInfo, 'utf8') : null;
const readPlist = (file) =>
  JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
const originalInfoValues = target === 'ios' ? readPlist(iosInfo) : null;
const localNetworkDescription =
  'Connect to your configured Drifting development service on the local network.';
const infoOverrides = { NSLocalNetworkUsageDescription: localNetworkDescription };
if (target === 'ios') {
  const folder = path.join(root, '.local-data/hosted-lab');
  mkdirSync(folder, { recursive: true });
  if (origin.startsWith('http://')) {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    infoOverrides.NSAppTransportSecurity = {
      NSExceptionDomains: { [host]: { NSExceptionAllowsInsecureHTTPLoads: true } },
    };
  }
  const infoFile = path.join(folder, 'Info.ios.plist');
  writeFileSync(infoFile, JSON.stringify(infoOverrides));
  execFileSync('plutil', ['-convert', 'xml1', infoFile]);
  override.bundle.iOS = { infoPlist: infoFile };
}
const env = {
  ...process.env,
  VITE_LOCAL_ONLY_MODE: 'false',
  VITE_REQUIRE_AUTH: 'false',
  VITE_AI_TRANSPORT: 'direct',
  VITE_CLOSED_BETA: 'false',
  VITE_API_BASE_URL: origin,
  API_BASE_URL: origin,
  DRIFTING_HOSTED_ORIGIN: origin,
  DRIFTING_DB_DIR:
    process.env.DRIFTING_DB_DIR ?? `.local-data/hosted-lab${peer ? '-peer' : ''}/databases`,
};
if (target === 'ios' && command === 'build') {
  const sdk =
    args.includes('aarch64-sim') || args.includes('x86_64') ? 'iphonesimulator' : 'iphoneos';
  env.SDKROOT = execFileSync('xcrun', ['--sdk', sdk, '--show-sdk-path'], {
    encoding: 'utf8',
  }).trim();
}
if (target === 'ios')
  env.PATH = `${path.join(root, 'scripts/apple-toolchain')}${path.delimiter}${env.PATH}`;
let binary = 'pnpm';
let parameters;
if (target === 'desktop')
  parameters = ['exec', 'tauri', command, ...args, '--config', JSON.stringify(override)];
else if (command === 'dev') {
  binary = process.execPath;
  parameters = [
    'scripts/run-mobile-dev.mjs',
    target,
    ...args,
    '--config',
    JSON.stringify(override),
  ];
} else
  parameters = ['exec', 'tauri', target, command, ...args, '--config', JSON.stringify(override)];
const projectFile = path.join(root, 'src-tauri/gen/apple/drifting.xcodeproj/project.pbxproj');
const originalProject = target === 'ios' ? readFileSync(projectFile, 'utf8') : null;
function restoreProjectIdentity() {
  if (originalProject === null) return;
  // Tauri persists the --config identity in the generated project. Revert only
  // those exact build-owned lines, preserving any other concurrent file edits.
  const current = readFileSync(projectFile, 'utf8');
  let restored = current;
  for (const property of ['PRODUCT_BUNDLE_IDENTIFIER', 'PRODUCT_NAME']) {
    const expression = new RegExp(`^(\\s*${property} = )(.+);$`, 'gm');
    const original = [...originalProject.matchAll(expression)].map((match) => match[2]);
    let index = 0;
    restored = restored.replace(expression, (line, prefix, value) => {
      const prior = original[index++];
      const expected = property === 'PRODUCT_NAME' ? `"${labName}"` : labIdentifier;
      return prior && value === expected ? `${prefix}${prior};` : line;
    });
  }
  if (restored !== current) writeFileSync(projectFile, restored);
  const currentInfo = readPlist(iosInfo);
  for (const [key, value] of Object.entries(infoOverrides)) {
    if (JSON.stringify(currentInfo[key]) !== JSON.stringify(value)) continue;
    if (Object.hasOwn(originalInfoValues, key)) {
      execFileSync('plutil', [
        '-replace',
        key,
        '-json',
        JSON.stringify(originalInfoValues[key]),
        iosInfo,
      ]);
    } else {
      execFileSync('plutil', ['-remove', key, iosInfo]);
    }
  }
  // Preserve byte formatting when the only mutations were our temporary overrides.
  const restoredInfo = readPlist(iosInfo);
  if (
    Object.keys(restoredInfo).length === Object.keys(originalInfoValues).length &&
    Object.entries(restoredInfo).every(
      ([key, value]) => JSON.stringify(value) === JSON.stringify(originalInfoValues[key]),
    )
  )
    writeFileSync(iosInfo, originalInfo);
}
const child = spawn(binary, parameters, { cwd: root, env, stdio: 'inherit' });
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.on('close', (code) => {
  restoreProjectIdentity();
  process.exitCode = code ?? 1;
});
