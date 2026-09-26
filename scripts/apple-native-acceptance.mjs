import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const iosOnly = process.argv.includes('--ios-only');
const bindingOnly = process.argv.includes('--binding-only');
const includeIPad = process.argv.includes('--include-ipad');
const includeIOS = iosOnly || includeIPad || process.argv.includes('--with-ios');
const simulatorKinds = includeIOS ? (includeIPad ? ['iPhone', 'iPad'] : ['iPhone']) : [];
const desktopUI = process.argv.includes('--macos-ui') && !iosOnly && !bindingOnly;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = `.local-data/apple-native/acceptance-${stamp}`;
mkdirSync(directory, { recursive: true });
const report = { schemaVersion: 1, kind: 'apple_native_lab_acceptance', generatedAt: new Date().toISOString(),
  status: 'running', scope: includeIOS ? 'selected native hosts and opted-in simulator checks; no physical device or IME claim'
    : 'macOS build, core and source-matched programmatic AppKit acceptance; mobile platforms deferred',
  simulatorKinds,
  source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    runtimeFingerprint: JSON.parse(readFileSync('docs/apple-native/acceptance/inventory.json', 'utf8')).source.runtimeFingerprint },
  checks: [], limits: { editor: 'inline, sibling and scoped blockquote structure; disjoint structural drafts; full P2 incomplete', ime: 'not-run', physicalDevice: 'not-run', realAccount: 'not-run',
    distribution: 'not-run', minimumOSExecution: 'not-run', intelBuild: 'not-run',
    desktopXCTest: desktopUI ? 'pending' : 'not-run', programmaticAppKit: iosOnly ? 'not-run' : 'pending',
    uikitTextInput: includeIOS ? 'pending' : 'deferred', iPhone: includeIOS ? 'pending' : 'deferred',
    iPad: includeIPad ? 'pending' : 'deferred' } };
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? `${directory}/report.json`;
function run(label, command, args, timeout = 300000) {
  console.log(`Running ${label}`);
  const logPath = `${directory}/${label}.log`;
  const log = openSync(logPath, 'w');
  let result;
  try { result = spawnSync(command, args, { timeout, stdio: ['ignore', log, log] }); }
  finally { closeSync(log); }
  const captured = readFileSync(logPath, 'utf8');
  if (result.error || result.status !== 0) throw new Error(`${label} failed; see ${directory}/${label}.log`);
  const check = { name: label, status: 'passed' };
  if (command === 'cargo') {
    const counts = [...captured.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
    check.passed = counts.reduce((sum, value) => sum + Number(value[1]), 0);
    assert(check.passed > 0, 'No Rust tests executed');
  }
  report.checks.push(check);
  return captured;
}
function ui(label, scheme, destination, rustTarget) {
  const bundle = `${directory}/${label}.xcresult`;
  run(label, 'xcodebuild', ['-project', 'native/apple/DriftingNativeLab.xcodeproj', '-scheme', scheme,
    '-configuration', 'Debug', '-derivedDataPath', 'native/apple/build/DerivedData',
    '-destination', destination, '-resultBundlePath', bundle,
    '-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never',
    `DRIFTING_RUST_TARGET=${rustTarget}`, `ARCHS=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
    'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGN_IDENTITY=-', 'DEVELOPMENT_TEAM=', 'test'], 600000);
  const summary = JSON.parse(execFileSync('xcrun', ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle, '--format', 'json'], { encoding: 'utf8' }));
  const binding = label.endsWith('-binding');
  assert(summary.passedTests >= (binding ? 25 : label === 'macos-ui' ? 1 : 4)
    && summary.failedTests === 0 && summary.skippedTests === 0, 'Native cases must execute and pass');
  Object.assign(report.checks.at(-1), { passed: summary.passedTests, failed: summary.failedTests,
    operation: binding ? 'act boundary create rename and remove preserve outline expansion live editor selection/history and cold reopen; chapter trash and restore preserve other owners, guard drafts and cold-open restored prose; complete chapter originals create editable chapters with cold reopen, metadata delivery returns workspace lists while retaining existing owner selection/history and rejects invalid originals atomically; canonical workspace originals through shared serial queue, queued Unicode input and local-only history, marked/failed branch retention, all-owner duplicate/reconcile delivery and committed-save retry; project title/prose search with current anchored UTF-16 match resolution, stale result refusal, selection/history and pending/marked input guards; outline navigation by current heading identity, no authored history, prefix edits and reopen; selection formatting, real heading levels and body reset, native text attributes, one-step history, links/comments and SQLite reopen; stored dependency recovery with held queued or marked input, accurate recovery status, original suffix selection, continued input and SQLite reopen; late original-left quote prefix, mixed original-prefix and safe suffix packet, interleaved Unicode b-d-b source clocks, two-view routed and original-suffix selections, two history cycles, duplicate delivery and SQLite reopen; actual UITextInput marked commit/cancel, remote overlap and continued input, repeated-character identity, NFC/NFD replacement and composition with passive-view refresh, exact UTF-16 storage ranges and SQLite reopen, Unicode backspace, responder resignation, system history selectors/key commands/UndoManager and pending/composition guards; synthetic temporary databases'
      : 'native outline controls create rename and remove act boundaries across process restart while preserving chapter prose; chapter trash survives process restart and restores editable prose through native controls; project search from chapter list and editor, exact match selection and continued editing across chapters; whole-book outline expansion and current/cross-chapter heading navigation; native heading menu and persisted structure after process restart, project/chapter creation and rename, chapter reorder, prose edit and history retained after rename/reorder, save/reopen, two-chapter isolation, names and chapter order after process restart',
    platforms: summary.devicesAndConfigurations.map(item => ({ platform: item.device.platform, osVersion: item.device.osVersion, model: item.device.modelName })) });
}
try {
  run('inventory', 'pnpm', ['apple:check']);
  if (!bindingOnly) {
    run('core', 'cargo', ['test', '--manifest-path', 'crates/drifting-core/Cargo.toml', '--locked']);
    run('prose-durability', 'cargo', ['test', '--manifest-path', 'crates/drifting-prose/Cargo.toml', '--locked']);
    run('bridge', 'cargo', ['test', '--manifest-path', 'crates/drifting-apple-bridge/Cargo.toml', '--locked']);
  }
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (!iosOnly) {
    if (!bindingOnly) run('macos-build', process.execPath, ['scripts/apple-native.mjs', 'macos']);
    // apple:binding:acceptance owns execution and exact source provenance. Use
    // its checked report instead of repeating an already accepted AppKit run.
    run('macos-binding', process.execPath, ['scripts/apple-binding-acceptance.mjs', '--check']);
    const bindingPath = 'docs/apple-native/acceptance/p2b-binding.json';
    const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
    Object.assign(report.checks.at(-1), { passed: binding.cases.length,
      method: 'validated-source-matched-report', evidence: bindingPath,
      sourceFingerprint: binding.source.fingerprint });
    report.limits.programmaticAppKit = 'source-matched-report-passed';
    // Desktop event synthesis can open System Settings on a user's active Mac.
    // Keep it explicit; ordinary acceptance must not commandeer the desktop.
    if (desktopUI) {
      ui('macos-ui', 'DriftingNativeMac', 'platform=macOS', `${architecture}-apple-darwin`);
      report.limits.desktopXCTest = 'passed';
    }
  }
  if (includeIOS) {
    run('ios-simulator-build', process.execPath, ['scripts/apple-native.mjs', 'ios']);
    const available = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' })).devices;
    const ios = Object.entries(available).filter(([runtime]) => runtime.includes('.iOS-')).sort(([a], [b]) => b.localeCompare(a, 'en', { numeric: true }));
    const simulatorTarget = architecture === 'aarch64' ? 'aarch64-apple-ios-sim' : 'x86_64-apple-ios';
    for (const kind of simulatorKinds) {
      const selected = ios.flatMap(([, devices]) => devices).find(device => device.name.startsWith(kind));
      assert(selected, `An available ${kind} simulator is required`);
      ui(`${kind.toLowerCase()}-binding`, 'DriftingNativeIOSBinding', `platform=iOS Simulator,id=${selected.udid}`, simulatorTarget);
      if (!bindingOnly) ui(`${kind.toLowerCase()}-ui`, 'DriftingNativeIOS', `platform=iOS Simulator,id=${selected.udid}`, simulatorTarget);
      report.limits[kind] = bindingOnly ? 'hosted-binding-passed' : 'simulator-passed';
    }
    report.limits.uikitTextInput = 'programmatic-hosted-tests-passed';
    if (!iosOnly && !bindingOnly) run('ios-device-unsigned-build', process.execPath, ['scripts/apple-native.mjs', 'ios-device']);
  }
  run('source-still-current', 'pnpm', ['apple:check']);
  assert.equal(JSON.parse(readFileSync('docs/apple-native/acceptance/inventory.json', 'utf8')).source.runtimeFingerprint,
    report.source.runtimeFingerprint, 'Runtime source changed during acceptance; regenerate the report');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  if (report.limits.desktopXCTest === 'pending') report.limits.desktopXCTest = 'failed-or-not-reached';
  report.failure = String(error.message).replaceAll(root, '<repository>/');
  process.exitCode = 1;
} finally {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${output}`);
}
