// Build-only preparation and read-only collection. Launch and all UI input use CUA.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = value => createHash('sha256').update(value).digest('hex');
const run = (command, args, env = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } });
const home = path.resolve('.local-data/apple-native/system-ime');
const manifest = path.resolve(option('prepared') ?? path.join(home, 'prepared.json'));
const write = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const inputs = () => run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
  .filter(file => file && existsSync(file) && (/^(crates\/|vendor\/yrs\/|drizzle\/|native\/apple\/(Shared|macOS|FFI)\/)/.test(file)
    || ['native/apple/Tests/SystemIMEAcceptance.swift', 'scripts/apple-system-ime-acceptance.mjs', 'scripts/apple-performance-rustc-wrapper.sh',
      'docs/apple-native/fixtures/document-v1.json', 'package.json', 'pnpm-lock.yaml'].includes(file))).sort();
const fingerprint = () => hash(JSON.stringify(inputs().map(file => ({ file, sha256: hash(readFileSync(file)) }))));
assert.equal(process.platform, 'darwin', 'System IME observation requires macOS');
assert(process.argv.includes('--prepare') !== process.argv.includes('--collect'), 'Choose --prepare or --collect; neither mode launches a GUI');

if (process.argv.includes('--prepare')) {
  const inputSource = option('input-source') ?? 'com.apple.inputmethod.SCIM.ITABC';
  assert.match(inputSource, /^[A-Za-z0-9._-]+$/, 'Expected a macOS input-source identifier');
  mkdirSync(home, { recursive: true });
  const owned = mkdtempSync(path.join(home, 'run-')), sourceFingerprint = fingerprint();
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64', target = `${arch}-apple-darwin`;
  const targetDir = path.resolve('.local-data/apple-native/rust');
  writeFileSync(path.join(owned, 'rust.log'), run('cargo', ['+1.96', 'build', '--locked', '--manifest-path',
    'crates/drifting-apple-bridge/Cargo.toml', '--target', target], { CARGO_TARGET_DIR: targetDir, MACOSX_DEPLOYMENT_TARGET: '14.0',
    RUSTC_WRAPPER: path.resolve('scripts/apple-performance-rustc-wrapper.sh') }));
  const bundle = path.join(owned, 'DriftingSystemIME.app'), binary = path.join(bundle, 'Contents/MacOS/SystemIMEAcceptance');
  const resources = path.join(bundle, 'Contents/Resources');
  mkdirSync(path.dirname(binary), { recursive: true }); mkdirSync(resources, { recursive: true });
  const identifier = 'cc.drifting.native-system-ime.lab';
  writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>SystemIMEAcceptance</string><key>CFBundleName</key><string>Drifting System IME</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  const rawReport = path.join(owned, 'raw.json'), phase = path.join(owned, 'phase.json');
  write(path.join(resources, 'ime-config.json'), { directory: path.join(owned, 'owner/apple-native-lab'), report: rawReport, phase, inputSource });
  writeFileSync(path.join(owned, 'swift.log'), run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-I', 'native/apple/FFI',
    '-L', `${targetDir}/${target}/debug`, '-ldrifting_apple_bridge', '-liconv', '-framework', 'AppKit', '-framework', 'Carbon',
    'native/apple/Shared/LabCore.swift', 'native/apple/Shared/DocumentBinding.swift', 'native/apple/Shared/DocumentStore.swift',
    'native/apple/Shared/DocumentStyle.swift', 'native/apple/macOS/NativeDocumentView.swift',
    'native/apple/Tests/SystemIMEAcceptance.swift', '-o', binary]));
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
  assert.equal(fingerprint(), sourceFingerprint, 'Source changed during system IME preparation');
  write(manifest, { schemaVersion: 1, kind: 'apple-system-ime-prepared', status: 'built-not-run', sourceFingerprint,
    sourceCommit: run('git', ['rev-parse', 'HEAD']).trim(), owned, bundle, binary, identifier, phase, rawReport, inputSource,
    binarySha256: hash(readFileSync(binary)), configSha256: hash(readFileSync(path.join(resources, 'ime-config.json'))) });
  console.log(`Prepared only; launch with CUA: ${bundle}\nObserve phase: ${phase}\nManifest: ${manifest}`);
} else {
  const prepared = JSON.parse(readFileSync(manifest));
  assert.equal(prepared.kind, 'apple-system-ime-prepared');
  assert.equal(prepared.sourceFingerprint, fingerprint(), 'System IME source changed after preparation');
  assert.equal(prepared.binarySha256, hash(readFileSync(prepared.binary)), 'Prepared executable changed');
  assert.equal(prepared.configSha256, hash(readFileSync(path.join(prepared.bundle, 'Contents/Resources/ime-config.json'))));
  const rawBytes = readFileSync(prepared.rawReport), sample = JSON.parse(rawBytes);
  assert.equal(sample.kind, 'apple-system-ime-observation');
  assert.equal(sample.inputSource, prepared.inputSource);
  if (sample.status === 'passed') {
    assert.equal(sample.originalInputSourceRestored, true);
    const required = ['type-basic-marked-not-persisted', 'commit-basic-Chinese-persisted', 'basic-single-undo-redo-and-reopen',
      'system-Escape-cancel-keeps-prose', 'remote-disjoint-paragraph-preserves-system-marked-text', 'remote-single-undo-redo-and-reopen'];
    for (const name of required) assert(sample.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing system IME gate: ${name}`);
  }
  const output = path.resolve(option('output') ?? path.join(home, 'latest.json'));
  write(output, { schemaVersion: 1, kind: 'apple_system_ime_acceptance', status: sample.status,
    generatedAt: new Date().toISOString(), source: { commit: prepared.sourceCommit, fingerprint: prepared.sourceFingerprint },
    binarySha256: prepared.binarySha256, rawReportSha256: hash(rawBytes), sample,
    scope: `CUA keyboard events routed through macOS input source ${prepared.inputSource} into the synthetic AppKit editor; observer-only helper` });
  console.log(`${sample.status}: ${output}`);
  if (sample.status !== 'passed') process.exitCode = 1;
}
