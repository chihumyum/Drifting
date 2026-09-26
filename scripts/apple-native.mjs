import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const mode = process.argv[2] ?? 'macos';
if (!['macos', 'ios', 'ios-device'].includes(mode)) throw new Error('Expected macos, ios or ios-device');
if (process.platform !== 'darwin') throw new Error('Apple application builds require macOS and Xcode');
const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const target = mode === 'macos' ? `${architecture}-apple-darwin`
  : mode === 'ios-device' ? 'aarch64-apple-ios'
  : architecture === 'aarch64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';
const cargoTarget = path.join(root, '.local-data/apple-native/rust');
mkdirSync(cargoTarget, { recursive: true });
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('cargo', ['build', '--manifest-path', 'crates/drifting-apple-bridge/Cargo.toml', '--locked', '--target', target], { CARGO_TARGET_DIR: cargoTarget, MACOSX_DEPLOYMENT_TARGET: '14.0', IPHONEOS_DEPLOYMENT_TARGET: '17.0' });
run('xcodegen', ['generate', '--spec', 'native/apple/project.yml']);
run('xcodebuild', ['-project', 'native/apple/DriftingNativeLab.xcodeproj',
  '-scheme', mode === 'macos' ? 'DriftingNativeMac' : 'DriftingNativeIOS',
  '-configuration', 'Debug', '-derivedDataPath', 'native/apple/build/DerivedData',
  '-destination', mode === 'macos' ? 'generic/platform=macOS' : `generic/platform=iOS${mode === 'ios' ? ' Simulator' : ''}`,
  `DRIFTING_RUST_TARGET=${target}`, `ARCHS=${mode === 'ios-device' ? 'arm64' : process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
  'CODE_SIGNING_ALLOWED=NO', 'build', '-quiet']);
