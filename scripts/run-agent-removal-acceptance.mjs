import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const integration = 'src/renderer/store/agent-chat-removal.integration.test.ts';
const suites = [integration, 'src/renderer/lib/agent/runtime/chat-conversation-removal.test.ts',
  'src/renderer/features/settings/agent-usage-history.test.ts', 'src/renderer/store/agent-chat-navigation.integration.test.ts',
  'src/renderer/store/agent-chat-preparation.integration.test.ts',
  'src/renderer/store/agent-chat-store.test.ts', 'src/renderer/store/agent-chat-events.integration.test.ts'];
const output = path.join(root, 'docs/renderer-performance/acceptance/f4-conversation-removal.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(rendererSourceFingerprint(root) + [fileURLToPath(import.meta.url), ...['run-agent-removal-ui.mjs', 'renderer-agent-removal-ui.tsx', 'renderer-agent-removal-ui.html'].map(file => path.join(root, 'scripts', file))].map(file => readFileSync(file, 'utf8')).join('\0'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function validate(report) {
  assert.equal(report.kind, 'agent_conversation_removal_acceptance'); assert.equal(report.status, 'passed');
  assert.deepEqual(report.suites, suites); assert.equal(report.tests.length, 75);
  assert(report.tests.every(test => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(new Set(report.tests.map(test => test.name)).size, 75);
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.baseline.commit, /^[a-f0-9]{40}$/);
  assert.equal(report.baseline.tests.length, 11);
  assert.equal(report.baseline.tests.filter(test => test.status === 'failed').length, 10);
  assert.deepEqual(report.baseline.tests.filter(test => test.status === 'passed').map(test => test.title), ['invalidates only a hydration affected by deleting old while loading old']);
  assert(report.baseline.tests.every(test => report.tests.some(current => current.name === test.name && current.status === 'passed')));
  assert.equal(report.baseline.testSha256, hash(readFileSync(path.join(root, integration))));
  assert.deepEqual(report.acceptance, { productionStore: true, repositories: 'real-SQLite-removal-probes-and-synthetic-regression-ports', provider: 'synthetic-controls-port',
    native: 'not-run', performanceBudget: 'not-evaluated', storageCancellation: 'not-proven' });
  assert.equal(report.browserUi.build, 'development-React-StrictMode-isolated-Chromium');
  assert.equal(report.browserUi.ports, 'synthetic-conversation-repository');
  assert.deepEqual(Object.keys(report.browserUi.checks), ['strictEffectReplay', 'pendingAndFailedDeletePreservesRows', 'committedUsageRetained', 'confirmationProjectOwnership', 'pendingProjectRowsIsolated', 'explicitClearProject', 'lateClearPreservesNewView', 'closeAndReopen']);
  assert(Object.values(report.browserUi.checks).every(value => value === true)); assert.deepEqual(report.browserUi.uncaughtErrors, []);
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Conversation removal evidence is stale.');
  console.log('Conversation removal evidence matches source: 75 checks and eight actual-component browser checks; native/provider acceptance not inferred.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-agent-removal-acceptance-'));
  const baseline = path.join(temporary, 'baseline'); let added = false;
  const sourceFingerprint = fingerprint(); const commit = git('rev-parse', 'HEAD');
  const baseRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11)
    ?? (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).baseline.commit : commit);
  const baselineCommit = git('rev-parse', baseRef);
  function run(directory, files, name, expectedStatus) {
    const resultFile = path.join(temporary, `${name}.json`);
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${resultFile}`], { cwd: directory, encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    const data = JSON.parse(readFileSync(resultFile, 'utf8'));
    assert.equal(data.numPendingTests, 0);
    assert.deepEqual(data.testResults.map(suite => path.relative(realpathSync(directory), realpathSync(suite.name))).sort(), [...files].sort());
    return data.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName,
      title: test.title, status: test.status, durationMs: test.duration ?? 0 })));
  }
  try {
    git('worktree', 'add', '--detach', baseline, baselineCommit); added = true;
    cpSync(path.join(root, integration), path.join(baseline, integration));
    symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const baselineTests = run(baseline, [integration], 'baseline', 1);
    const tests = run(root, suites, 'current', 0);
    const uiFile = path.join(temporary, 'ui.json');
    const ui = spawnSync('node', ['scripts/run-agent-removal-ui.mjs', `--output=${uiFile}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (ui.error) throw ui.error; assert.equal(ui.status, 0, ui.stdout + ui.stderr);
    const browserUi = JSON.parse(readFileSync(uiFile, 'utf8'));
    assert.equal(fingerprint(), sourceFingerprint, 'Source changed during acceptance.');
    const report = { kind: 'agent_conversation_removal_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: 'Eleven identical store probes use disposable WAL/FULL files with all product migrations and real conversation repositories. Gateway holds bracket the actual deletion statement; SQLite integrity and foreign keys are checked after every probe. Provider/memory ports are synthetic. Other regression suites and the browser UI use synthetic ports.',
      source: { commit, fingerprint: sourceFingerprint, build: 'vitest-real-SQLite-and-isolated-React-UI' }, suites, tests, browserUi,
      baseline: { commit: baselineCommit, testSha256: hash(readFileSync(path.join(root, integration))), tests: baselineTests },
      acceptance: { productionStore: true, repositories: 'real-SQLite-removal-probes-and-synthetic-regression-ports', provider: 'synthetic-controls-port', native: 'not-run',
        performanceBudget: 'not-evaluated', storageCancellation: 'not-proven' } };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Conversation removal acceptance: identical 11 real-SQLite store probes, baseline 10 failures -> 0; 75 current checks and eight browser UI checks passed.');
  } finally {
    if (added) git('worktree', 'remove', '--force', baseline);
    rmSync(temporary, { recursive: true, force: true });
  }
}
