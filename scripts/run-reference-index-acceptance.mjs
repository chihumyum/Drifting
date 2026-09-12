import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReferenceIndexUiAcceptance } from './reference-index-ui-acceptance.mjs';
import { referenceEvidenceFingerprint } from './reference-index-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const behaviorSuites = [
  'src/renderer/services/reference-index-repository.integration.test.ts',
  'src/renderer/services/reference-index-queue.integration.test.ts',
  'src/renderer/lib/db.test.ts',
  'src/renderer/sync/prose-change-scope.test.ts',
  'src/renderer/sync/engine/durable-runtime.integration.test.ts',
];
const readSuite = 'src/renderer/services/reference-index-reads.acceptance.test.ts';
const suites = [...behaviorSuites, readSuite];
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? 'docs/renderer-performance/acceptance/f6-reference-reads.json';
const fingerprint = () => referenceEvidenceFingerprint(root);

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'reference_index_scoped_reads_acceptance');
  assert.equal(report.status, 'passed');
  assert.equal(report.source.build, 'vitest-sqlite-and-isolated-chromium');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.suites, suites);
  assert.equal(report.tests.length, 97);
  assert.equal(new Set(report.tests.map((test) => test.name)).size, report.tests.length);
  assert(report.tests.every((test) => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(report.acceptance.runtimeQueueConnected, true);
  assert.equal(report.acceptance.hardKillRecovery, 'not-run');
  assert.equal(report.acceptance.nativeOrPhysicalDevice, 'not-run');
  assert.equal(report.acceptance.performanceComparison, 'sqlite-returned-data-and-headless-timings');
  assert.equal(report.queueOperations.sourceCount, 100);
  assert.equal(report.queueOperations.startup.written, 100);
  assert.equal(report.queueOperations.metadata.prepared, 0);
  assert.equal(report.queueOperations.metadata.written, 0);
  assert.equal(report.queueOperations.metadata.reused, 100);
  assert.equal(report.queueOperations.oneBodyChange.prepared, 1);
  assert.equal(report.queueOperations.oneBodyChange.written, 1);
  assert.equal(report.queueOperations.oneBodyChange.capture, 'sources');
  assert.equal(report.queueOperations.oneBodyChange.sources, 1);
  assert.equal(report.queueOperations.oneBodyChange.reused, 0);
  assert.deepEqual(report.sqliteReads.map((scenario) => scenario.sources), [64, 1024]);
  for (const scenario of report.sqliteReads) {
    assert.equal(scenario.samples.length, 10);
    const full = scenario.samples.filter((sample) => sample.capture === 'full');
    const selected = scenario.samples.filter((sample) => sample.capture === 'sources');
    assert.equal(full.length, 5); assert.equal(selected.length, 5);
    for (const sample of scenario.samples) {
      assert.equal(sample.stats.prepared, 1); assert.equal(sample.stats.written, 1);
      assert.equal(sample.publications, 1);
      assert(sample.elapsedMs >= 0 && sample.reads.queryMs >= 0);
    }
    assert(full.every((sample) => sample.reads.rows >= scenario.sources * 2));
    assert(selected.every((sample) => sample.stats.sources === 1 && sample.reads.rows < 50 && sample.reads.serializedBytes < full[0].reads.serializedBytes / 8));
  }
  assert.equal(report.ui.mountedCommits, 1);
  assert.equal(report.ui.healthyNotifications, 100);
  assert.equal(report.ui.healthyProgressCommits, 0);
  assert.equal(report.ui.checks.length, 5);
  assert(report.ui.checks.every((check) => check.passed));
  assert.deepEqual(report.ui.layouts.map((layout) => layout.viewportWidth), [375, 375, 1280]);
  assert(report.ui.layouts.every((layout) => layout.fits));
  assert(report.limitations.length >= 3);
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Reference queue evidence is stale; regenerate it.');
  console.log('Reference scoped-read, queue and UI evidence match source. Headless timings do not establish native input latency.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-reference-evidence-'));
  try {
    const sourceFingerprint = fingerprint();
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const countsPath = path.join(temporary, 'queue-operations.json');
    const readsPath = path.join(temporary, 'sqlite-reads.json');
    const testResults = [];
    // Read measurements run alone, after behavior tests and before Chromium.
    for (const [index, group] of [behaviorSuites, [readSuite]].entries()) {
      const jsonPath = path.join(temporary, `tests-${index}.json`);
      const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...group, '--reporter=json', `--outputFile=${jsonPath}`], {
        encoding: 'utf8', env: { ...process.env, DRIFTING_REFERENCE_QUEUE_COUNTERS: countsPath, DRIFTING_REFERENCE_READ_COUNTERS: readsPath },
      });
      if (run.error) throw run.error;
      if (run.status !== 0) {
        process.stderr.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
        throw new Error(`Reference acceptance failed (${run.status}).`);
      }
      const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
      assert.equal(result.success, true); assert.equal(result.numFailedTests, 0); assert.equal(result.numPendingTests, 0);
      assert.deepEqual(result.testResults.map((test) => path.relative(root, test.name)).sort(), [...group].sort());
      testResults.push(...result.testResults);
    }
    const ui = await runReferenceIndexUiAcceptance(root);
    assert.equal(sourceFingerprint, fingerprint(), 'Source changed during acceptance; discard this run.');
    const report = {
      schemaVersion: 1, kind: 'reference_index_scoped_reads_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: {
        commit: sourceCommit, fingerprint: sourceFingerprint,
        dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
        build: 'vitest-sqlite-and-isolated-chromium',
      },
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: { provenance: 'synthetic test-local content', database: 'integration suites: temporary files, WAL, FULL, complete product migrations; db unit suite: fake gateway', ui: 'actual notice/styles/locales with a fixture status seam and production React profiling renderer' },
      suites,
      tests: testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration }))),
      queueOperations: JSON.parse(readFileSync(countsPath, 'utf8')),
      sqliteReads: JSON.parse(readFileSync(readsPath, 'utf8')),
      ui,
      acceptance: {
        durableTransactionBoundary: 'passed', runtimeQueueConnected: true, hardKillRecovery: 'not-run',
        nativeOrPhysicalDevice: 'not-run', performanceComparison: 'sqlite-returned-data-and-headless-timings',
      },
      limitations: [
        'Provider and editor wiring is implemented; SQLite tests exercise the service with ordinary, Agent and remote commit events. Full application/native/device acceptance is not exercised.',
        'Failure injection, rollback and owner restart are exercised in-process; process termination and restart recovery are not exercised.',
        'The read matrix compares the current full-capture fallback with selected capture on identical synthetic data. It is not a separate historical-build comparison.',
        'SQL timings are Node SQLite gateway observations. Pass elapsed time includes query result serialization used to count returned bytes. Neither establishes native IPC, input latency or total workspace refresh time.',
        'Returned rows and serialized bytes measure data crossing the query adapter, not SQLite physical pages scanned. Source parsing/replacement is one in both modes, with one project reference publication in both modes.',
        'Startup, restore, sync-runtime recreation, unknown or oversized scopes, failed or stale writes and structural changes retain complete capture. Structural workspace partial reads remain pending.',
        'UI behavior/layout use an isolated real component with a fixture status seam; they do not prove the complete reference panel or native shell.',
      ],
    };
    validate(report);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, status: report.status, tests: report.tests.length, source: report.source }, null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
