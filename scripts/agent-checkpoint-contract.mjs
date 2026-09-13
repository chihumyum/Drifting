import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';
export const checkpointBoundaries = ['message', 'checkpoint', 'compaction', 'lifecycle', 'before-commit', 'committed'];
export const checkpointWorkerFiles = ['scripts/agent-checkpoint-worker.mjs', 'src/renderer/performance/agent-checkpoint-worker.ts', 'src/renderer/performance/agent-checkpoint-fixture.ts'];
export const checkpointTestFile = 'src/renderer/sqlite-repo/agent-checkpoint-retention.integration.test.ts';
export const checkpointSuites = [checkpointTestFile, 'src/renderer/sqlite-repo/agent-runtime-persistence-repo.integration.test.ts',
  'src/renderer/lib/agent/runtime/repository-transport-persistence.test.ts', 'src/renderer/lib/agent/runtime/repository-transport-persistence-v2.integration.test.ts',
  'src/renderer/lib/agent/runtime/acceptance/p3-product-migrations.integration.test.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
export const checkpointWorkerHash = root => hash(checkpointWorkerFiles.map(file => readFileSync(path.join(root, file), 'utf8')).join('\0'));
export function checkpointFingerprint(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'drizzle', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  files.push('scripts/agent-checkpoint-worker.mjs', 'scripts/agent-checkpoint-contract.mjs', 'scripts/run-agent-checkpoint-acceptance.mjs');
  return hash(rendererSourceFingerprint(root) + [...new Set(files)].sort().map(file => `${file}\0${hash(readFileSync(path.join(root, file)))}`).join('\n'));
}
export const checkpointAcceptance = { sqlite: 'file-backed-product-schema-WAL-FULL', provider: 'synthetic-journal-and-normalized-history',
  currentCrashCases: 12, currentKills: 12, independentRestarts: 24, nativeDatabaseTests: 18, upgradePrefixes: [1, 2, 3],
  nativeUI: 'not-run', nativeCheckpointCrash: 'not-run', powerLoss: 'not-run', deviceBudget: 'not-evaluated' };
const checkHash = value => assert.match(value, /^[a-f0-9]{64}$/);
function validateMeasurements(measurements, current) {
  assert.deepEqual(measurements.map(item => item.count), [100, 1000, 5000]);
  for (const item of measurements) {
    assert.equal(item.mode, 'measure'); assert.equal(item.seed, 1); assert.deepEqual(item.exit, { code: 0, signal: null });
    assert.equal(item.lists.length, 3); assert.equal(item.listMs.length, 3); assert(item.listMs.every(value => Number.isFinite(value) && value >= 0));
    assert(Number.isFinite(item.commitMs) && item.commitMs >= 0); checkHash(item.providerHash);
    assert.deepEqual(item.checks, ['read-only-list', 'full-provider-history', 'two-anchors', 'actual-query-plan']);
    assert.deepEqual(item.lists.map(read => read.rows), Array(3).fill(current ? 2 : item.count));
    assert.deepEqual(item.commitReads.map(read => read.rows), current ? [2, 2] : [item.count, item.count - 1]);
    for (const read of [...item.lists, ...item.commitReads]) {
      assert(Number.isFinite(read.bytes) && read.bytes > 0);
      assert.equal(read.plan.some(line => line.includes('idx_agent_runtime_checkpoint_full_anchor')), current);
      assert(read.plan.some(line => line.includes('agent_runtime_checkpoint')));
    }
  }
}
export function validateCheckpointAcceptance(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'agent_checkpoint_retention'); assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); checkHash(report.source.fingerprint); checkHash(report.workerSha256);
  assert.deepEqual(report.acceptance, checkpointAcceptance); assert.deepEqual(report.suites, checkpointSuites);
  assert.equal(report.tests.length, 36); assert(report.tests.every(test => test.status === 'passed')); assert.equal(new Set(report.tests.map(test => test.name)).size, 36);
  assert.equal(report.native.tests.length, 18); assert.equal(new Set(report.native.tests).size, 18);
  assert(report.native.tests.includes('database::tests::project_upgrades_preserve_published_prefixes_with_same_version_safety_snapshots'));
  assert(report.native.tests.includes('database::tests::sigkill_matrix_reconciles_to_exactly_old_or_new_database'));
  assert.equal(report.native.exitCode, 0); assert.equal(report.native.failed, 0);
  assert.match(report.baseline.commit, /^[a-f0-9]{40}$/); assert.equal(report.baseline.workerSha256, report.workerSha256);
  assert.equal(report.baseline.tests.length, 8); assert.equal(report.baseline.tests.filter(test => test.status === 'failed').length, 6);
  assert.equal(report.baseline.tests.filter(test => test.status === 'passed').length, 2);
  checkHash(report.baseline.testSha256); assert.equal(report.baseline.testSha256, report.testSha256);
  assert(report.baseline.tests.every(test => report.tests.some(current => current.name === test.name && current.status === 'passed')));
  validateMeasurements(report.measurements, true); validateMeasurements(report.baseline.measurements, false);
  for (let index = 0; index < report.measurements.length; index++) {
    assert.equal(report.measurements[index].providerHash, report.baseline.measurements[index].providerHash);
    assert(report.measurements[index].lists[0].bytes < report.baseline.measurements[index].lists[0].bytes);
  }
  assert.deepEqual(report.crashes.map(item => `${item.boundary}/${item.seed}`), checkpointBoundaries.flatMap(boundary => [1, 2].map(seed => `${boundary}/${seed}`)));
  for (const item of report.crashes) {
    const { kill } = item; const cut = checkpointBoundaries.indexOf(item.boundary); const committed = item.boundary === 'committed';
    assert.equal(kill.mode, 'write'); assert.equal(kill.boundary, item.boundary); assert.equal(kill.seed, item.seed); assert.equal(kill.ready, true);
    assert.deepEqual(kill.exit, { code: null, signal: 'SIGKILL' });
    for (const field of ['beforeHash', 'foreignHash', 'beforeProviderHash', 'afterProviderHash']) checkHash(kill[field]);
    assert.equal(kill.observed.messages, cut === 0 ? 1 : 3); assert.equal(kill.observed.checkpoint, cut >= 1);
    assert.deepEqual(kill.observed.compacted, cut >= 2 ? [2] : []); assert.equal(kill.observed.terminal, cut >= 3); assert.equal(kill.observed.committed, committed);
    assert.equal(kill.observed.transactionIds.length, cut === 0 ? 1 : cut === 1 ? 4 : cut === 2 ? 5 : 6);
    assert.equal(new Set(kill.observed.transactionIds).size, 1); assert.equal(typeof kill.observed.transactionIds[0], 'string');
    assert.equal(item.restarts.length, 2); assert.deepEqual(item.restarts[0], item.restarts[1]);
    for (const restart of item.restarts) {
      assert.equal(restart.mode, 'recover'); assert.equal(restart.boundary, item.boundary); assert.equal(restart.seed, item.seed); assert.equal(restart.recovered, true);
      assert.deepEqual(restart.exit, { code: 0, signal: null }); assert.equal(restart.foreignHash, kill.foreignHash);
      checkHash(restart.databaseHash); checkHash(restart.displayHash);
      assert.equal(restart.providerHash, committed ? kill.afterProviderHash : kill.beforeProviderHash);
      assert.deepEqual(restart.fullOrdinals, committed ? [4, 6] : [2, 4]); assert.equal(restart.lastTurnStatus, committed ? 'completed' : 'running');
      assert.equal(restart.checkpoints, committed ? 4 : 3);
      assert.deepEqual(restart.checks, ['read-only-recovery-and-old-commit-retry', 'integrity', 'foreign-keys']);
      if (committed) assert.notEqual(restart.databaseHash, kill.beforeHash); else assert.equal(restart.databaseHash, kill.beforeHash);
    }
  }
}
