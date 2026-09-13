import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceEvidenceFingerprint } from './workspace-projection-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const suites = [
  'src/renderer/services/workspace-projection-refresh.integration.test.ts',
  'src/renderer/services/workspace-projection-coverage.integration.test.ts',
  'src/renderer/store/data-store.workspace-projection.test.ts',
  'src/renderer/app/providers/remote-sync-store-refresh.acceptance.test.ts',
  'src/renderer/app/providers/project-runtime-local-bootstrap.acceptance.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts',
  'src/renderer/sync/protocol/domain-manifest.test.ts',
  'src/dev-cli/manifest.test.ts',
];
const measuredSuite = 'src/renderer/services/workspace-projection-reads.acceptance.test.ts';
const nativeArgs = ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'database::tests', '--', '--nocapture'];
const output = 'docs/renderer-performance/acceptance/f6-workspace-reads.json';
const fingerprint = () => workspaceEvidenceFingerprint(root);
const nonnegative = (value) => Number.isFinite(value) && value >= 0;

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'workspace_scoped_reads_acceptance');
  assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.suites, [...suites, measuredSuite]);
  assert.equal(report.tests.length, 84);
  assert.equal(new Set(report.tests.map((test) => test.name)).size, report.tests.length);
  assert(report.tests.every((test) => test.status === 'passed' && nonnegative(test.durationMs)));
  assert.deepEqual(report.nativeDatabase.command, ['cargo', ...nativeArgs]);
  assert.equal(report.nativeDatabase.tests.length, 18);
  assert.equal(new Set(report.nativeDatabase.tests.map((test) => test.name)).size, 18);
  assert(report.nativeDatabase.tests.every((test) => test.status === 'passed'));
  assert(report.nativeDatabase.tests.some((test) => test.name.endsWith('project_upgrades_preserve_published_prefixes_with_same_version_safety_snapshots')));
  assert(report.nativeDatabase.tests.some((test) => test.name.endsWith('sigkill_matrix_reconciles_to_exactly_old_or_new_database')));
  assert.deepEqual(report.sqliteReads.map((scenario) => scenario.entitiesPerKind), [64, 1024]);
  for (const scenario of report.sqliteReads) {
    assert.equal(scenario.bodyCharacters, 8200);
    assert.equal(scenario.reads.length, 10); assert.equal(scenario.writes.length, 10);
    const full = scenario.reads.filter((sample) => sample.mode === 'full');
    const selected = scenario.reads.filter((sample) => sample.mode === 'changes');
    assert.equal(full.length, 5); assert.equal(selected.length, 5);
    for (const sample of scenario.reads) {
      assert.equal(sample.publications, 1);
      assert(nonnegative(sample.captureMs) && nonnegative(sample.publicationMs));
      for (const count of ['queries', 'rows', 'serializedBytes']) assert(Number.isSafeInteger(sample.reads[count]) && sample.reads[count] >= 0);
      assert(nonnegative(sample.reads.queryAwaitMs));
    }
    assert(full.every((sample) => sample.nodeRead === 'all' && sample.reads.rows > scenario.entitiesPerKind * 2));
    assert(selected.every((sample) => sample.nodeRead === 'changed' && sample.reads.queries === 4 && sample.reads.rows === 4 && sample.reads.serializedBytes < full[0].reads.serializedBytes / 8));
    for (const tracking of [true, false]) {
      const samples = scenario.writes.filter((sample) => sample.tracking === tracking);
      assert.equal(samples.length, 5);
      assert(samples.every((sample) => sample.updates === 200 && nonnegative(sample.executeMs) && nonnegative(sample.transactionMs)));
    }
  }
  assert.deepEqual(report.acceptance, {
    coveredCollections: 'passed', changedNodeRows: 'passed', fullFallback: 'passed',
    nativeMigrationAndSafetySnapshot: 'passed', headlessReadAndWriteCost: 'measured',
    fullAppPerformance: 'not-run', nativeRendererOrPhysicalDevice: 'not-run',
  });
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    throw new Error(`Workspace acceptance failed (${command}: ${result.status}).`);
  }
  return result;
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Workspace evidence is stale; regenerate it.');
  console.log('Workspace scoped reads, write-cost measurements and native migration evidence match source. Full-app and device acceptance are not claimed.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-workspace-evidence-'));
  try {
    const sourceFingerprint = fingerprint();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const tests = [];
    const vitest = (selected, name, env) => {
      const jsonPath = path.join(temporary, `${name}.json`);
      run('pnpm', ['exec', 'vitest', 'run', ...selected, '--reporter=json', `--outputFile=${jsonPath}`], env);
      const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
      assert.equal(result.success, true); assert.equal(result.numFailedTests, 0); assert.equal(result.numPendingTests, 0);
      assert.deepEqual(result.testResults.map((test) => path.relative(root, test.name)).sort(), [...selected].sort());
      tests.push(...result.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration }))));
    };
    vitest(suites, 'behavior');
    console.log('Workspace behavioral and schema checks passed.');
    const native = run('cargo', nativeArgs);
    const nativeTests = [...native.stdout.matchAll(/^test (database::tests::\S+) \.\.\. ok$/gm)].map((match) => ({ name: match[1], status: 'passed' }));
    console.log(`Native database checks passed: ${nativeTests.length}. Starting isolated measurements.`);
    const countersPath = path.join(temporary, 'reads.json');
    // Native/correctness work is terminal before the isolated measurement process.
    vitest([measuredSuite], 'measured', { ...process.env, DRIFTING_WORKSPACE_READ_COUNTERS: countersPath });
    assert.equal(sourceFingerprint, fingerprint(), 'Source changed during acceptance; discard this run.');
    const report = {
      schemaVersion: 1, kind: 'workspace_scoped_reads_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: sourceFingerprint, dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) },
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: 'Synthetic temporary WAL/FULL SQLite files with the complete product migrations; actual capture/repositories, refresh queue and Zustand stores. Coverage includes production historical remote materialization. Native tests use disposable databases and real shadow migration safety snapshots.',
      suites: [...suites, measuredSuite], tests,
      nativeDatabase: { command: ['cargo', ...nativeArgs], tests: nativeTests },
      sqliteReads: JSON.parse(readFileSync(countersPath, 'utf8')),
      acceptance: { coveredCollections: 'passed', changedNodeRows: 'passed', fullFallback: 'passed', nativeMigrationAndSafetySnapshot: 'passed', headlessReadAndWriteCost: 'measured', fullAppPerformance: 'not-run', nativeRendererOrPhysicalDevice: 'not-run' },
      limitations: [
        'This measurement exercises covered metadata-only node rows (up to 128 IDs). Covered existing live element bodies also use individual reads plus ordered live IDs; their before/after measurements are recorded separately by workspace:elements:acceptance. Other affected collections read completely, with membership and cascade dependencies. Initial, restored, expired, reset or untrusted coverage reads the full workspace.',
        'The production remote reducer may rematerialize historical winners. SQLite triggers record actual writes in the same transaction; current mutation IDs and delivery of every event are not assumed. A missed notification is reconciled on the next capture, not immediately without any event.',
        'Read measurements use one warm pair and five alternating full/covered pairs on Node SQLite. Returned bytes are serialized results, not physical pages. Capture time includes observer serialization. queryAwaitMs sums overlapping asynchronous gateway calls and is not SQL CPU time or an additive wall-clock phase.',
        'Write controls drop and restore exactly the three node triggers only inside a disposable fixture, then alternate five pairs of 200 updates in a single transaction. This isolates synthetic trigger cost; it does not model one fsync per keystroke or native IPC.',
        'Virtual timers check queue scheduling and publication races, not latency. Headless store publication timing does not measure full React rendering, interaction latency or physical input.',
        'Native tests prove both published migration prefixes upgrade through verified same-version safety snapshots and failures preserve the old database. The native migration SIGKILL matrix is separate from the renderer workspace queue SIGKILL report.',
      ],
    };
    validate(report);
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ output, tests: tests.length, nativeTests: nativeTests.length, source: report.source }, null, 2));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
