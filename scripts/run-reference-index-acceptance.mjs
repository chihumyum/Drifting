import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReferenceIndexUiAcceptance } from './reference-index-ui-acceptance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const suites = [
  'src/renderer/services/reference-index-repository.integration.test.ts',
  'src/renderer/services/reference-index-queue.integration.test.ts',
  'src/renderer/lib/db.test.ts',
];
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? 'docs/renderer-performance/acceptance/f6-reference-queue.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fingerprint() {
  const files = [];
  const visit = (directory, pattern) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, pattern);
      else if (pattern.test(file)) files.push(path.relative(root, file));
    }
  };
  visit(path.join(root, 'src/renderer'), /\.(ts|tsx|css)$/);
  visit(path.join(root, 'src/styles'), /\.css$/);
  visit(path.join(root, 'drizzle'), /\.(sql|json)$/);
  files.push('scripts/run-reference-index-acceptance.mjs', 'vitest.config.ts', 'vitest.shared.ts', 'package.json', 'pnpm-lock.yaml');
  files.push('scripts/reference-index-ui-acceptance.mjs', 'scripts/reference-index-ui-service.ts', 'scripts/reference-index-ui.tsx', 'scripts/reference-index-ui.html', 'src/renderer/locales/en.json', 'src/renderer/locales/zh-CN.json', 'tailwind.config.js');
  return hash(files.sort().map((file) => `${file}\0${hash(readFileSync(file))}`).join('\n'));
}

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'reference_index_queue_acceptance');
  assert.equal(report.status, 'passed');
  assert.equal(report.source.build, 'vitest-sqlite-and-isolated-chromium');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.suites, suites);
  assert.equal(report.tests.length, 58);
  assert.equal(new Set(report.tests.map((test) => test.name)).size, report.tests.length);
  assert(report.tests.every((test) => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(report.acceptance.runtimeQueueConnected, true);
  assert.equal(report.acceptance.hardKillRecovery, 'not-run');
  assert.equal(report.acceptance.nativeOrPhysicalDevice, 'not-run');
  assert.equal(report.acceptance.performanceComparison, 'operation-counts-only');
  assert.equal(report.queueOperations.sourceCount, 100);
  assert.equal(report.queueOperations.startup.written, 100);
  assert.equal(report.queueOperations.metadata.prepared, 0);
  assert.equal(report.queueOperations.metadata.written, 0);
  assert.equal(report.queueOperations.metadata.reused, 100);
  assert.equal(report.queueOperations.oneBodyChange.prepared, 1);
  assert.equal(report.queueOperations.oneBodyChange.written, 1);
  assert.equal(report.queueOperations.oneBodyChange.reused, 99);
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
  console.log('Reference queue and UI evidence match source. Hard-kill recovery and partial reads remain pending.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-reference-evidence-'));
  try {
    const sourceFingerprint = fingerprint();
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const jsonPath = path.join(temporary, 'tests.json');
    const countsPath = path.join(temporary, 'queue-operations.json');
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${jsonPath}`], {
      encoding: 'utf8', env: { ...process.env, DRIFTING_REFERENCE_QUEUE_COUNTERS: countsPath },
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      process.stderr.write(run.stdout ?? '');
      process.stderr.write(run.stderr ?? '');
      throw new Error(`Reference queue acceptance failed (${run.status}).`);
    }
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(result.success, true);
    assert.equal(result.numFailedTests, 0);
    assert.equal(result.numPendingTests, 0);
    assert.equal(result.testResults.length, suites.length);
    assert.deepEqual(result.testResults.map((test) => path.relative(root, test.name)).sort(), [...suites].sort());
    const ui = await runReferenceIndexUiAcceptance(root);
    assert.equal(sourceFingerprint, fingerprint(), 'Source changed during acceptance; discard this run.');
    const report = {
      schemaVersion: 1, kind: 'reference_index_queue_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: {
        commit: sourceCommit, fingerprint: sourceFingerprint,
        dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
        build: 'vitest-sqlite-and-isolated-chromium',
      },
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: { provenance: 'synthetic test-local content', database: 'integration suites: temporary files, WAL, FULL, complete product migrations; db unit suite: fake gateway', ui: 'actual notice/styles/locales with a fixture status seam and production React profiling renderer' },
      suites,
      tests: result.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration }))),
      queueOperations: JSON.parse(readFileSync(countsPath, 'utf8')),
      ui,
      acceptance: {
        durableTransactionBoundary: 'passed', runtimeQueueConnected: true, hardKillRecovery: 'not-run',
        nativeOrPhysicalDevice: 'not-run', performanceComparison: 'operation-counts-only',
      },
      limitations: [
        'Provider and editor wiring is implemented; SQLite tests exercise the service with ordinary, Agent and remote commit events. Full application/native/device acceptance is not exercised.',
        'Failure injection, rollback and owner restart are exercised in-process; process termination and restart recovery are not exercised.',
        'Test durations are diagnostic only. Parser/write/React commit locality is checked; database latency, input latency and total refresh time are not measured.',
        'Every queue pass still reads a full source catalog, database-wide Yjs version metadata and project reference coverage counts, including after pure prose commits; this is not a database-read optimization.',
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
