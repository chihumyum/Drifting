// Reproduce the upstream failure with pristine sources, then require every
// patched fixed-seed stress run to pass. This is scoped dependency evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const output = 'docs/apple-native/acceptance/yrs-random-array-diagnostic.json';
const root = '.local-data/apple-native/yrs-diagnostic';
const seed = '15892911872676499736';
const source = JSON.parse(readFileSync('vendor/yrs/UPSTREAM.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = hash(readFileSync('vendor/yrs/UPSTREAM.json'));
const generatorFingerprint = hash(readFileSync('scripts/apple-yrs-diagnostic.mjs'));
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output));
  assert.equal(report.vendorFingerprint, fingerprint);
  assert.equal(report.generatorFingerprint, generatorFingerprint);
  assert.equal(report.status, 'baseline-failure-reproduced-and-patched-stress-passed');
  assert.equal(report.patchedStress.passed, 100);
  assert.equal(report.patchedStress.failed, 0);
  console.log('Sparse-replay diagnostic: upstream failure reproduced; 100 patched runs passed for current sources.');
  process.exit(0);
}
mkdirSync(root, { recursive: true });
cpSync('vendor/yrs', `${root}/source`, { recursive: true });
// Restore every patched file before calling this an unpatched baseline. The
// archive checksum and all original files are verified before fixing the seed.
const archive = spawnSync('python3', ['-c',
  'import pathlib,tarfile,sys,json,hashlib; p=next(pathlib.Path.home().glob(".cargo/registry/cache/*/yrs-0.28.0.crate")); s=json.loads(pathlib.Path("vendor/yrs/UPSTREAM.json").read_text()); assert hashlib.sha256(p.read_bytes()).hexdigest()==s["archiveSha256"]; t=tarfile.open(p); dest=pathlib.Path(sys.argv[1]); [(dest/x["path"]).write_bytes(t.extractfile("yrs-0.28.0/"+x["path"]).read()) for x in s["patches"]]', `${root}/source`],
{ maxBuffer: 4 * 1024 * 1024 });
assert.equal(archive.status, 0, 'Published crate must be in the local Cargo cache');
for (const [file, expected] of Object.entries(source.originalFiles)) {
  assert.equal(hash(readFileSync(`${root}/source/${file}`)), expected, `Baseline differs from upstream: ${file}`);
}
const arrayPath = `${root}/source/src/types/array.rs`;
const array = readFileSync(arrayPath, 'utf8');
assert.equal(hash(array), source.originalFiles['src/types/array.rs']);
writeFileSync(arrayPath, array.replace('run_scenario(0, &array_transactions(), 5, iterations)',
  `run_scenario(${seed}, &array_transactions(), 5, iterations)`));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  kind: 'yrs_upstream_random_array_diagnostic', status: 'not-reproduced', vendorFingerprint: fingerprint, generatorFingerprint,
  version: '0.28.0', test: 'types::array::test::fuzzy_test_300', seed,
  baseline: 'All patched files restored from the checksum-verified published archive; all original file hashes verified. Only the test seed is fixed in an ignored temporary copy.',
  interpretation: 'The scenario seed is fixed; hash iteration still varies. Baseline failure is retained, and every patched stress attempt must pass. Native deterministic replay tests and Yjs exchange are separate evidence.',
  limits: 'Scoped sparse-hole replay regression only; does not establish full P2, v2 output, physical input, production durability or release readiness.', attempts: 0 };
for (let attempt = 1; attempt <= 100; attempt++) {
  const result = spawnSync('cargo', ['test', '--manifest-path', `${root}/source/Cargo.toml`, '--lib', '--features', 'sync', '--locked',
    '--target-dir', '.local-data/apple-native/yrs-diagnostic-target', report.test, '--', '--exact', '--nocapture'],
  { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.signal) throw new Error('Diagnostic did not complete');
  report.attempts = attempt;
  writeFileSync(`${root}/attempt-${attempt}.log`, result.stdout + result.stderr);
  if (result.status !== 0) {
    assert.match(result.stdout, /test result: FAILED\. 0 passed; 1 failed;/);
    assert.match(result.stderr, /PendingUpdate/);
    report.status = 'unpatched-upstream-failure-reproduced';
    report.failure = result.stderr.slice(result.stderr.indexOf("thread '")).replaceAll(process.cwd(), '<repository>');
    break;
  }
}
if (report.status === 'unpatched-upstream-failure-reproduced') {
  cpSync('vendor/yrs', `${root}/patched`, {recursive: true});
  // Use the identical scenario with the recorded patches. Keep both Cargo
  // target directories separate to prevent baseline/patched artifact reuse.
  writeFileSync(`${root}/patched/src/types/array.rs`, array.replace('run_scenario(0, &array_transactions(), 5, iterations)',
    `run_scenario(${seed}, &array_transactions(), 5, iterations)`));
  report.patchedStress = {passed: 0, failed: 0, runs: 100, iterationsPerRun: 300, seed};
  for (let attempt = 1; attempt <= 100; attempt++) {
    const result = spawnSync('cargo', ['test', '--manifest-path', `${root}/patched/Cargo.toml`, '--lib', '--features', 'sync', '--locked',
      '--target-dir', '.local-data/apple-native/yrs-diagnostic-patched-target', report.test, '--', '--exact', '--nocapture'],
    {encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024});
    writeFileSync(`${root}/patched-${attempt}.log`, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    if (result.error || result.signal || result.status !== 0) {
      report.patchedStress.failed++;
      report.status = 'patched-stress-failed';
      report.patchedFailure = `${result.error ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`.replaceAll(process.cwd(), '<repository>');
      break;
    }
    assert.match(result.stdout, /test result: ok\. 1 passed; 0 failed;/);
    report.patchedStress.passed++;
  }
  if (report.patchedStress.passed === 100) report.status = 'baseline-failure-reproduced-and-patched-stress-passed';
}
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status}: ${output}`);
if (report.status !== 'baseline-failure-reproduced-and-patched-stress-passed') process.exitCode = 1;
