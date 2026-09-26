import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
  ?? 'docs/apple-native/acceptance/p2c-native-performance.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const inputFiles = () => [...new Set(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
  .filter(file => file && existsSync(file) && (/^(crates\/|vendor\/yrs\/|drizzle\/|native\/apple\/(Shared|macOS|FFI)\/|src\/renderer\/components\/editor\/)/.test(file)
    || ['native/apple/Tests/EditorPerformance.swift', 'scripts/apple-native-editor-performance.mjs',
      'scripts/apple-editor-performance-baseline.ts', 'scripts/apple-performance-rustc-wrapper.sh', 'src/renderer/lib/extensions/block-id.ts',
      'src/renderer/lib/extensions/paragraph-indent.ts', 'src/renderer/lib/extensions/entity-link.ts',
      'src/renderer/domain/entity-kinds.ts', 'src/renderer/lib/retroactive-entity-links.ts',
      'package.json', 'pnpm-lock.yaml'].includes(file))).sort();
const fingerprint = () => hash(JSON.stringify(inputFiles().map(file => ({ path: file, sha256: hash(readFileSync(file)) }))));
// y-prosemirror emits attrs:{} on attribute-free marks; ProseMirror omits it.
// Normalize only this serialization difference, never block/unknown metadata.
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, canonical(child)]));
  if (result.marks) for (const mark of result.marks) {
    if (mark.attrs && Object.keys(mark.attrs).length === 0) delete mark.attrs;
  }
  return result;
};
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output));
  assert.equal(report.status, 'measured');
  assert.equal(report.source.fingerprint, fingerprint(), 'Native performance sample is stale');
  console.log('Native performance source fingerprint is current; its explicit limits still apply.');
  process.exit(0);
}
assert.equal(process.platform, 'darwin');
const directory = `.local-data/apple-native/editor-performance/native-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(directory, { recursive: true });
const source = { commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty: Boolean(run('git', ['status', '--porcelain']).trim()), fingerprint: fingerprint() };
const report = { schemaVersion: 1, kind: 'apple_native_editor_performance', status: 'running', source,
  generatedAt: new Date().toISOString(), scope: 'Release AppKit prototype; visible real NSTextView and shared durable owner; synthetic isolated databases' };
function command(label, cmd, args, env = {}) {
  const fd = openSync(`${directory}/${label}.log`, 'w');
  let result;
  try { result = spawnSync(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', fd, fd], timeout: 600000 }); }
  finally { closeSync(fd); }
  assert(!result.error && result.status === 0, `${label} failed: ${directory}/${label}.log`);
}
try {
  const corpusPath = `${directory}/corpus.json`;
  command('corpus', process.execPath, ['--conditions=import', '--import=tsx', 'scripts/apple-editor-performance-baseline.ts', `--out=${corpusPath}`]);
  const corpus = JSON.parse(readFileSync(corpusPath));
  const rustTarget = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`;
  const targetDir = path.resolve('.local-data/apple-native/performance-rust');
  command('bridge-build', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'crates/drifting-apple-bridge/Cargo.toml', '--target', rustTarget],
    { CARGO_TARGET_DIR: targetDir, MACOSX_DEPLOYMENT_TARGET: '14.0', RUSTC_WRAPPER: path.resolve('scripts/apple-performance-rustc-wrapper.sh') });
  command('fixture-build', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'crates/drifting-prose/Cargo.toml', '--example', 'scale-fixture', '--target-dir', 'crates/drifting-prose/target']);
  for (const entry of corpus.cases) command(`seed-${entry.id}`, 'crates/drifting-prose/target/release/examples/scale-fixture',
    [corpusPath, 'native', entry.id, `${directory}/cases/${entry.id}/apple-native-lab`]);
  const bundle = `${directory}/DriftingNativePerformance.app`;
  mkdirSync(`${bundle}/Contents/MacOS`, { recursive: true });
  const binary = `${bundle}/Contents/MacOS/EditorPerformance`;
  writeFileSync(`${bundle}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>cc.drifting.native-performance.lab</string>
<key>CFBundleExecutable</key><string>EditorPerformance</string><key>CFBundleName</key><string>Drifting Native Performance</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`);
  command('swift-build', 'xcrun', ['swiftc', '-O', '-parse-as-library', '-swift-version', '5', '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, '-I', 'native/apple/FFI', '-L', `${targetDir}/${rustTarget}/release`,
    '-ldrifting_apple_bridge', '-liconv', '-framework', 'AppKit', '-framework', 'QuartzCore',
    'native/apple/Shared/LabCore.swift', 'native/apple/Shared/DocumentBinding.swift', 'native/apple/Shared/DocumentStore.swift',
    'native/apple/Shared/DocumentStyle.swift', 'native/apple/macOS/NativeDocumentView.swift',
    'native/apple/Tests/EditorPerformance.swift', '-o', binary]);
  command('adhoc-sign', '/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', bundle]);
  const binarySha256 = hash(readFileSync(binary));
  command('measurement', '/usr/bin/open', ['-n', '-W', '--stdout', path.resolve(`${directory}/application.log`),
    '--stderr', path.resolve(`${directory}/application.log`), path.resolve(bundle), '--args', path.resolve(corpusPath),
    path.resolve(`${directory}/cases`), path.resolve(`${directory}/raw.json`),
    ...(process.argv.includes('--interactive') ? ['--interactive'] : [])]);
  assert(existsSync(`${directory}/raw.json`),
    `Native collector produced no sample: ${readFileSync(`${directory}/application.log`, 'utf8').trim().slice(-2000)}`);
  const sample = JSON.parse(readFileSync(`${directory}/raw.json`));
  assert.equal(sample.status, 'measured'); assert.equal(sample.corpusSha256, corpus.corpusSha256);
  assert.equal(sample.cases.length, corpus.cases.length);
  for (const [index, measured] of sample.cases.entries()) {
    const entry = corpus.cases[index];
    assert.equal(measured.id, entry.id); assert.equal(measured.dispatchToTwoFrames.samplesMs.length, 30);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Buffer.from(measured.updateBase64, 'base64'));
      const semantic = yDocToProsemirrorJSON(doc, 'default');
      assert.deepEqual(canonical(semantic), canonical(entry.proseMirrorJson), `Measured native edits changed ${entry.id} schema/marks/IDs`);
      measured.exportSha256 = hash(Buffer.from(measured.updateBase64, 'base64'));
      measured.independentYjsReplay = 'passed';
    } finally { doc.destroy(); }
    delete measured.updateBase64;
  }
  assert.equal(hash(readFileSync(binary)), binarySha256);
  assert.equal(fingerprint(), source.fingerprint, 'Source changed during native measurement');
  Object.assign(report, { status: 'measured', corpusSha256: corpus.corpusSha256, binarySha256,
    hardware: { model: run('sysctl', ['-n', 'hw.model']).trim(), architecture: process.arch }, sample,
    interpretation: 'Two display-link callbacks expose frame opportunities; physical key latency and displayed pixels were not measured. Cached native surfaces are not full workspace chapter switches. Separate prototype databases do not certify large-project startup or P2 performance exit.' });
} catch (error) {
  report.status = 'failed'; report.failure = String(error.message).replaceAll(root, '<repository>/'); process.exitCode = 1;
} finally {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${output}`);
  if (report.failure) console.error(report.failure);
}
