import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const suites = [
  'src/renderer/services/workspace-projection-refresh.integration.test.ts',
  'src/renderer/store/data-store.workspace-projection.test.ts',
  'src/renderer/app/providers/remote-sync-store-refresh.acceptance.test.ts',
];
const output = 'docs/renderer-performance/acceptance/f6-workspace-refresh.json';
const fingerprint = () => createHash('sha256')
  .update(referenceEvidenceFingerprint(root))
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .update(readFileSync(new URL('./reference-index-evidence.mjs', import.meta.url)))
  .digest('hex');

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'workspace_refresh_correctness_acceptance');
  assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.suites, suites);
  assert.equal(report.tests.length, 28);
  assert.equal(new Set(report.tests.map((test) => test.name)).size, report.tests.length);
  assert(report.tests.every((test) => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(report.acceptance.workspaceCapture, 'full');
  assert.equal(report.acceptance.partialReads, 'not-implemented');
  assert.equal(report.acceptance.performance, 'not-measured');
  assert.equal(report.acceptance.nativeOrPhysicalDevice, 'not-run');
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Workspace refresh evidence is stale; regenerate it.');
  console.log('Workspace refresh correctness evidence matches source; partial reads and performance are not claimed.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-workspace-refresh-evidence-'));
  try {
    const sourceFingerprint = fingerprint();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const jsonPath = path.join(temporary, 'tests.json');
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${jsonPath}`], { encoding: 'utf8' });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      process.stderr.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
      throw new Error(`Workspace acceptance failed (${run.status}).`);
    }
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(result.success, true); assert.equal(result.numFailedTests, 0); assert.equal(result.numPendingTests, 0);
    assert.deepEqual(result.testResults.map((test) => path.relative(root, test.name)).sort(), [...suites].sort());
    assert.equal(sourceFingerprint, fingerprint(), 'Source changed during acceptance; discard this run.');
    const report = {
      schemaVersion: 1, kind: 'workspace_refresh_correctness_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: sourceFingerprint, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) },
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: 'Synthetic temporary SQLite files with the complete product schema; actual capture/repositories, refresh queue and Zustand stores. Selected reads are delayed or failed to exercise publication races. Timers are virtual.',
      suites,
      tests: result.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration }))),
      acceptance: { workspaceCapture: 'full', partialReads: 'not-implemented', performance: 'not-measured', nativeOrPhysicalDevice: 'not-run' },
      limitations: [
        'Queue integration exercises real file-backed SQLite captures and renderer stores. Provider event routing and bootstrap wiring have source assertions; the full React provider/app and native shell are not mounted here.',
        'Virtual timers verify coalescing, first-arrival scheduling and bounded retry behavior, not wall-clock interaction latency or SQLite performance.',
        'Structural captures still read the complete workspace. The remote reducer can rematerialize historical winners, so current-mutation IDs alone cannot authorize partial reads.',
        'This report does not test process termination, cross-device or physical input. Reference-index SIGKILL evidence is generated separately.',
      ],
    };
    validate(report);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, tests: report.tests.length, source: report.source }, null, 2));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
