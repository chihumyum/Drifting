import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceEvidenceFingerprint } from './workspace-projection-evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const measured = 'src/renderer/services/workspace-projection-comment-reads.acceptance.test.ts';
const suites = ['src/renderer/services/workspace-projection-comments.integration.test.ts',
  'src/renderer/services/workspace-projection-coverage.integration.test.ts'];
const output = path.resolve(root, process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/renderer-performance/acceptance/f6-comment-reads.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => workspaceEvidenceFingerprint(root);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function validate(report) {
  assert.equal(report.kind, 'workspace_comment_reads_acceptance'); assert.equal(report.status, 'passed');
  assert.deepEqual(report.suites, [...suites, measured]); assert.equal(report.tests.length, 73);
  assert(report.tests.every(test => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(new Set(report.tests.map(test => test.name)).size, 73);
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.baseline.commit, /^[a-f0-9]{40}$/);
  assert.equal(report.baseline.testSha256, hash(readFileSync(path.join(root, measured))));
  assert.equal(report.baseline.tests.length, 4); assert(report.baseline.tests.every(test => test.status === 'passed'));
  for (const scenarios of [report.baseline.reads, report.reads]) {
    assert.deepEqual(scenarios.map(({ kind, entities }) => [kind, entities]), [['comments', 64], ['comments', 1024], ['actions', 64], ['actions', 1024]]);
    for (const scenario of scenarios) {
      assert.equal(scenario.bodyCharacters, 8200); assert.equal(scenario.samples.length, 5);
      for (const sample of scenario.samples) {
        for (const field of ['queries', 'rows', 'serializedBytes', 'payloadRows']) assert(Number.isSafeInteger(sample[field]) && sample[field] > 0);
        assert(Number.isFinite(sample.captureMs) && sample.captureMs >= 0);
      }
    }
  }
  for (let index = 0; index < report.reads.length; index++) {
    const current = report.reads[index]; const baseline = report.baseline.reads[index];
    assert(baseline.samples.every(sample => sample.payloadRows === baseline.entities + 1 && sample.queries === 4));
    assert(current.samples.every(sample => sample.payloadRows === 1 && sample.queries === 4 && sample.rows === 4));
    assert(current.samples.every(sample => sample.serializedBytes < Math.min(...baseline.samples.map(value => value.serializedBytes)) / 16));
  }
  assert.deepEqual(report.acceptance, { productionCapture: true, sqlite: 'temporary-WAL-FULL', fullProjectionOracle: true,
    unchangedCommentObjects: true, fullFallback: true, nativeRenderer: 'not-run', fullAppPerformance: 'not-measured' });
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report);
  if (!process.argv.includes('--historical')) assert.equal(report.source.fingerprint, fingerprint(), 'Comment read evidence is stale.');
  console.log(process.argv.includes('--historical') ? 'Historical comment read contract passed; current source was not asserted.' : 'Comment read evidence matches source: 73 checks and identical before/after SQLite measurement probes.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-workspace-comment-'));
  const baseline = path.join(temporary, 'baseline'); let added = false;
  const sourceFingerprint = fingerprint(); const commit = git('rev-parse', 'HEAD');
  const baseRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11)
    ?? (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).baseline.commit : commit);
  const baselineCommit = git('rev-parse', baseRef);
  function run(directory, files, name, measure = false) {
    const resultFile = path.join(temporary, `${name}.json`); const countersFile = path.join(temporary, `${name}-reads.json`);
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${resultFile}`],
      { cwd: directory, encoding: 'utf8', env: { ...process.env, ...(measure ? { DRIFTING_COMMENT_READ_COUNTERS: countersFile } : {}) } });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const data = JSON.parse(readFileSync(resultFile, 'utf8')); assert.equal(data.numPendingTests, 0);
    assert.deepEqual(data.testResults.map(suite => path.relative(realpathSync(directory), realpathSync(suite.name))).sort(), [...files].sort());
    return { tests: data.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName,
      status: test.status, durationMs: test.duration ?? 0 }))), reads: measure ? JSON.parse(readFileSync(countersFile, 'utf8')) : null };
  }
  try {
    git('worktree', 'add', '--detach', baseline, baselineCommit); added = true;
    cpSync(path.join(root, measured), path.join(baseline, measured));
    symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const before = run(baseline, [measured], 'baseline', true);
    const behavior = run(root, suites, 'behavior');
    const current = run(root, [measured], 'current', true);
    assert.equal(fingerprint(), sourceFingerprint, 'Source changed during acceptance.');
    const report = { kind: 'workspace_comment_reads_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: sourceFingerprint }, environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      suites: [...suites, measured], tests: [...behavior.tests, ...current.tests], reads: current.reads,
      baseline: { commit: baselineCommit, testSha256: hash(readFileSync(path.join(root, measured))), ...before },
      acceptance: { productionCapture: true, sqlite: 'temporary-WAL-FULL', fullProjectionOracle: true, unchangedCommentObjects: true,
        fullFallback: true, nativeRenderer: 'not-run', fullAppPerformance: 'not-measured' },
      limitations: [
        'Synthetic disposable product-schema databases, one warm capture then five samples per size and revision. Each covered result is compared with a fresh authoritative full projection. No author database is opened.',
        'Returned bytes are JSON-serialized gateway rows, not physical pages or native IPC traffic. Capture timing includes counter serialization and is a Node diagnostic, not an app latency budget.',
        'Up to 128 covered identities read only changed full rows. Stable createdAt and covered identities preserve rowid ties, so no complete ID query is needed. The renderer still merges an O(N) array; this is not constant total refresh cost.',
        'Identity replacement, lifecycle changes, oversized batches or unavailable coverage use the complete collection or workspace. Initial and restored projections are full. Published migrations are unchanged.',
        'Both comment collections order by createdAt ascending then SQLite rowid ascending. Changed timestamps promote the affected collection. Comments and actions are captured atomically, including cascade deletion.',
      ] };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Comment read acceptance passed: 73 checks; 65/1025 comment or action payloads reduced to one per edit.');
  } finally {
    if (added) git('worktree', 'remove', '--force', baseline);
    rmSync(temporary, { recursive: true, force: true });
  }
}
