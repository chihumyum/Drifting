import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const integration = 'src/renderer/store/agent-chat-navigation.integration.test.ts';
const suites = [integration, 'src/renderer/lib/agent/runtime/chat-conversation-navigation.test.ts',
  'src/renderer/store/agent-chat-preparation.integration.test.ts',
  'src/renderer/store/agent-chat-store.test.ts', 'src/renderer/store/agent-chat-events.integration.test.ts'];
const output = path.join(root, 'docs/renderer-performance/acceptance/f4-conversation-navigation.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(rendererSourceFingerprint(root) + readFileSync(fileURLToPath(import.meta.url), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function validate(report) {
  assert.equal(report.kind, 'agent_conversation_navigation_acceptance'); assert.equal(report.status, 'passed');
  assert.deepEqual(report.suites, suites); assert.equal(report.tests.length, 59);
  assert(report.tests.every(test => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(new Set(report.tests.map(test => test.name)).size, 59);
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.baseline.commit, /^[a-f0-9]{40}$/);
  assert.equal(report.baseline.tests.length, 15);
  assert.equal(report.baseline.tests.filter(test => test.status === 'failed').length, 9);
  assert.equal(report.baseline.tests.filter(test => test.status === 'passed').length, 6);
  assert(report.baseline.tests.every(test => report.tests.some(current => current.name === test.name && current.status === 'passed')));
  assert.equal(report.baseline.testSha256, hash(readFileSync(path.join(root, integration))));
  assert.deepEqual(report.acceptance, { productionStore: true, repositories: 'synthetic-ports', provider: 'synthetic-controls-port',
    native: 'not-run', performanceBudget: 'not-evaluated', storageCancellation: 'not-proven' });
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Conversation navigation evidence is stale.');
  console.log('Conversation navigation evidence matches source: 59 checks; native and provider acceptance not inferred.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-agent-navigation-acceptance-'));
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
    assert.equal(fingerprint(), sourceFingerprint, 'Source changed during acceptance.');
    const report = { kind: 'agent_conversation_navigation_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: sourceFingerprint, build: 'vitest-production-store-with-synthetic-ports' }, suites, tests,
      baseline: { commit: baselineCommit, testSha256: hash(readFileSync(path.join(root, integration))), tests: baselineTests },
      acceptance: { productionStore: true, repositories: 'synthetic-ports', provider: 'synthetic-controls-port', native: 'not-run',
        performanceBudget: 'not-evaluated', storageCancellation: 'not-proven' } };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Conversation navigation acceptance: identical 15 store probes, baseline 9 failures -> 0; 59 current checks passed.');
  } finally {
    if (added) git('worktree', 'remove', '--force', baseline);
    rmSync(temporary, { recursive: true, force: true });
  }
}
