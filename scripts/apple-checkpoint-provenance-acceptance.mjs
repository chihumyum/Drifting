// Collect real Vitest results; this sidecar claims only the checkpoint file's
// SQLite restore and immutable mutation-row checks, not all reducer semantics.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const script = 'scripts/apple-checkpoint-provenance-acceptance.mjs';
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = option('output') ?? 'docs/apple-native/acceptance/checkpoint-mutation-integrity.json';
const testFile = 'src/renderer/sync/checkpoint/checkpoint.integration.test.ts';
const suites = [testFile, 'src/renderer/sync/protocol/protocol.test.ts',
  'src/renderer/sync/restore/google-drive-restore.integration.test.ts'];
const group = 'provider-neutral checkpoint capture and isolated restore';
const tampering = ['payload bytes', 'payload hash', 'forged payload with matching row hash', 'action',
  'target family', 'target kind', 'target id', 'incarnation', 'payload version', 'missing row',
  'extra row with out-of-range index', 'negative index', 'duplicate index'];
// Fixed expectations deliberately do not discover/approve names from test code.
const required = [
  'materializes no project when any member of an atomic multi-SyncGeneration restore fails',
  'captures and restores snapshot-only, update-only, combined, and seed-only prose',
  'publishes every blob and the package before the only visible commit marker',
  'captures normalized authority and rebuilds a deliberately stale JSON projection',
  'fails capture before publishing a checkpoint with missing fractional list authority',
  'fails closed on missing/corrupt blobs and wrong projectSync without exposing a project',
  'rejects unknown package versions and invalid Yjs before materialization',
  ...tampering.map(label => `rejects rehashed checkpoint mutation-row ${label} without changing target domain state`),
].map(name => `${group} ${name}`).sort();
const scope = {
  acceptedTestFile: testFile, acceptedCases: 20, resealedMutationTamperCases: 13,
  boundary: 'Synthetic file-backed SQLite checkpoint validation and isolated restore; invalid mutation rows reject before asset preparation or domain activation, while failed-attempt bookkeeping remains durable.',
  excluded: ['Complete reducer-register semantic validation', 'Yjs alias deletion intent', 'Physical input or IME',
    'Native UI or device execution', 'Real-account sync', 'Distribution'],
};
const hash = value => createHash('sha256').update(value).digest('hex');
function manifest() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0');
  return [...new Set(paths)].filter(file => file && existsSync(file) && (
    /^src\/renderer\/sync\/(checkpoint|protocol|journal)\//u.test(file) || file.startsWith('drizzle/')
    || ['src/renderer/schema/drizzle.ts', 'package.json', 'pnpm-lock.yaml'].includes(file)))
    .sort().map(file => ({ path: file, sha256: hash(readFileSync(file)) }));
}
function relative(file) {
  const value = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  assert(value && !value.startsWith('../') && !path.isAbsolute(value), 'Vitest result must belong to this checkout');
  return value;
}
function validate(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'apple_checkpoint_mutation_integrity');
  assert.equal(report.status, 'passed'); assert.deepEqual(report.scope, scope);
  assert.equal(report.generator.path, script); assert.equal(report.generator.sha256, hash(readFileSync(script)));
  assert.deepEqual(report.source.files, manifest(), 'Checkpoint provenance evidence is stale');
  assert.equal(report.source.fingerprint, hash(JSON.stringify(report.source.files)));
  assert.deepEqual(report.cases, required.map(name => ({ name, status: 'passed' })));
  assert.deepEqual(report.run.requiredSuites.map(suite => suite.file).sort(), [...suites].sort());
  for (const suite of report.run.requiredSuites) {
    assert(suite.passed > 0); assert.equal(suite.failed, 0); assert.equal(suite.skipped, 0);
  }
  assert.equal(report.run.requiredSuites.find(suite => suite.file === testFile).passed, 20);
  assert(['collected-existing-vitest', 'ran-three-vitest-suites'].includes(report.run.mode));
  assert.match(report.run.rawSha256, /^[a-f0-9]{64}$/u);
  assert.equal(report.run.overall.success, true); assert.equal(report.run.overall.failed, 0);
  assert(report.run.overall.passed >= 20);
  assert.equal(report.run.overall.skipped, report.run.skippedTests.length);
  assert.equal(report.run.overall.total, report.run.overall.passed + report.run.overall.skipped);
  for (const skipped of report.run.skippedTests) {
    assert(!suites.includes(skipped.file)); assert.equal(relative(skipped.file), skipped.file);
    assert.equal(typeof skipped.name, 'string'); assert(['pending', 'skipped', 'todo'].includes(skipped.status));
  }
  assert(!/\/(?:Users|home|private\/var)\//u.test(JSON.stringify(report)), 'No local user paths in durable evidence');
}
if (process.argv.includes('--check')) {
  validate(JSON.parse(readFileSync(output, 'utf8')));
  console.log('Checkpoint mutation integrity: 20 source-matched file-backed cases; broader gates remain separate.');
  process.exit(0);
}

let rawPath = option('collect'), beforePath = option('source-before');
assert(Boolean(rawPath) === Boolean(beforePath), '--collect and --source-before must be provided together');
const mode = rawPath ? 'collected-existing-vitest' : 'ran-three-vitest-suites';
if (!rawPath) {
  mkdirSync('.local-data/apple-native', { recursive: true });
  const temporary = mkdtempSync('.local-data/apple-native/checkpoint-provenance-');
  rawPath = path.join(temporary, 'vitest.json'); beforePath = path.join(temporary, 'source-before.json');
  writeFileSync(beforePath, `${JSON.stringify(manifest(), null, 2)}\n`);
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${path.resolve(rawPath)}`],
    { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(temporary, 'vitest.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, 'Checkpoint Vitest run failed');
}
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
assert(Array.isArray(before));
const sortedBefore = [...before].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
assert.deepEqual(sortedBefore, manifest(), 'Source-before manifest must match every current scoped file exactly');
const rawBytes = readFileSync(rawPath), raw = JSON.parse(rawBytes);
assert.equal(raw.success, true); assert.equal(raw.numFailedTests, 0); assert.equal(raw.numFailedTestSuites, 0);
const all = raw.testResults.flatMap(suite => suite.assertionResults.map(test => ({ file: relative(suite.name),
  name: test.fullName, status: test.status })));
assert(all.length > 0 && all.every(test => ['passed', 'pending', 'skipped', 'todo'].includes(test.status)));
assert.equal(all.length, raw.numTotalTests);
const skippedTests = all.filter(test => test.status !== 'passed');
assert.equal(all.filter(test => test.status === 'passed').length, raw.numPassedTests);
assert.equal(skippedTests.length, raw.numPendingTests + raw.numTodoTests);
const requiredSuites = suites.map(file => {
  const matches = raw.testResults.filter(suite => relative(suite.name) === file);
  assert.equal(matches.length, 1, `Missing or repeated required Vitest suite: ${file}`);
  assert.equal(matches[0].status, 'passed');
  const tests = all.filter(test => test.file === file);
  assert(tests.length > 0 && tests.every(test => test.status === 'passed'), `Skipped or failed required suite: ${file}`);
  return { file, passed: tests.length, failed: 0, skipped: 0 };
});
const cases = all.filter(test => test.file === testFile).map(({ name, status }) => ({ name, status }))
  .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
assert.deepEqual(cases, required.map(name => ({ name, status: 'passed' })), 'Every fixed checkpoint gate must execute exactly once');
assert.deepEqual(manifest(), sortedBefore, 'Scoped sources changed during collection');
const report = { schemaVersion: 1, kind: 'apple_checkpoint_mutation_integrity', status: 'passed', generatedAt: new Date().toISOString(),
  generator: { path: script, sha256: hash(readFileSync(script)) },
  source: { fingerprint: hash(JSON.stringify(sortedBefore)), files: sortedBefore }, scope, cases,
  run: { mode, rawSha256: hash(rawBytes), requiredSuites,
    overall: { success: raw.success, total: raw.numTotalTests, passed: raw.numPassedTests, failed: raw.numFailedTests,
      skipped: skippedTests.length }, skippedTests },
};
validate(report);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Checkpoint mutation integrity: 20 accepted cases, including 13 resealed tamper refusals. ${output}`);
