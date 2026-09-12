import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const suite = 'src/renderer/services/reference-index-repository.integration.test.ts';
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? 'docs/renderer-performance/acceptance/f6-reference-boundary.json';
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
  visit(path.join(root, 'drizzle'), /\.(sql|json)$/);
  files.push('scripts/run-reference-index-acceptance.mjs', 'vitest.config.ts', 'vitest.shared.ts', 'package.json', 'pnpm-lock.yaml');
  return hash(files.sort().map((file) => `${file}\0${hash(readFileSync(file))}`).join('\n'));
}

function validate(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'reference_index_boundary_acceptance');
  assert.equal(report.status, 'passed');
  assert.equal(report.source.build, 'vitest-node-product-sqlite-gateway');
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.source.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(report.suite, suite);
  assert.equal(report.tests.length, 28);
  assert.equal(new Set(report.tests.map((test) => test.name)).size, report.tests.length);
  assert(report.tests.every((test) => test.status === 'passed' && test.durationMs >= 0));
  assert.equal(report.acceptance.runtimeQueueConnected, false);
  assert.equal(report.acceptance.hardKillRecovery, 'not-run');
  assert.equal(report.acceptance.nativeOrPhysicalDevice, 'not-run');
  assert.equal(report.acceptance.performanceComparison, 'not-run');
  assert(report.limitations.length >= 3);
}

if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8'));
  validate(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Reference boundary evidence is stale; regenerate it.');
  console.log('Reference boundary evidence matches source. Runtime queue and hard-kill recovery remain pending.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-reference-evidence-'));
  try {
    const sourceFingerprint = fingerprint();
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const jsonPath = path.join(temporary, 'tests.json');
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', suite, '--reporter=json', `--outputFile=${jsonPath}`], { encoding: 'utf8' });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      process.stderr.write(run.stdout ?? '');
      process.stderr.write(run.stderr ?? '');
      throw new Error(`Reference boundary acceptance failed (${run.status}).`);
    }
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(result.success, true);
    assert.equal(result.numFailedTests, 0);
    assert.equal(result.numPendingTests, 0);
    assert.equal(result.testResults.length, 1);
    assert.equal(path.relative(root, result.testResults[0].name), suite);
    assert.equal(sourceFingerprint, fingerprint(), 'Source changed during acceptance; discard this run.');
    const report = {
      schemaVersion: 1, kind: 'reference_index_boundary_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: {
        commit: sourceCommit, fingerprint: sourceFingerprint,
        dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
        build: 'vitest-node-product-sqlite-gateway',
      },
      environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      fixture: { provenance: 'synthetic test-local content', database: 'temporary file; WAL; FULL; complete product migration journal' },
      suite,
      tests: result.testResults[0].assertionResults.map((test) => ({ name: test.fullName, status: test.status, durationMs: test.duration })),
      acceptance: {
        durableTransactionBoundary: 'passed', runtimeQueueConnected: false, hardKillRecovery: 'not-run',
        nativeOrPhysicalDevice: 'not-run', performanceComparison: 'not-run',
      },
      limitations: [
        'This preparatory repository is not yet connected to ProjectRuntimeProvider or editor reference writes.',
        'Failure injection and SQLite rollback are exercised in-process; process termination and restart recovery are not exercised.',
        'Test durations are diagnostic only, not a renderer performance comparison, database latency budget, or app-wide acceptance.',
        'Catalog reads remain full; source versions and existence are revalidated before every derived replacement.',
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
