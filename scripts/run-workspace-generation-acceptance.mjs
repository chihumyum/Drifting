import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const integration = 'src/renderer/services/workspace-projection-generation.integration.test.ts';
const suites = [integration, 'src/renderer/services/workspace-projection-refresh.integration.test.ts', 'src/renderer/store/data-store.workspace-projection.test.ts', 'src/renderer/lib/entity-link-names.test.ts'];
const browserFiles = ['scripts/run-workspace-generation-browser.mjs', 'scripts/renderer-workspace-generation.html', 'src/renderer/performance/workspace-generation-scenario.tsx'];
const output = path.join(root, 'docs/renderer-performance/acceptance/f2-projection-generation.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(rendererSourceFingerprint(root) + [fileURLToPath(import.meta.url), ...browserFiles.map(file => path.join(root, file))].map(file => readFileSync(file, 'utf8')).join('\0'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function validate(report) {
  assert.equal(report.kind, 'workspace_projection_generation_acceptance'); assert.equal(report.status, 'passed');
  assert.deepEqual(report.suites, suites); assert.equal(report.tests.length, 38);
  assert(report.tests.every(test => test.status === 'passed' && test.durationMs >= 0)); assert.equal(new Set(report.tests.map(test => test.name)).size, 38);
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.baseline.tests.length, 8); assert.equal(report.baseline.tests.filter(test => test.status === 'failed').length, 7);
  assert.deepEqual(report.baseline.tests.filter(test => test.status === 'passed').map(test => test.title), ['rejects late captures across project A to B to A without changing the new generation']);
  assert.equal(report.baseline.testSha256, hash(readFileSync(path.join(root, integration))));
  for (const browser of [report.browser, report.baseline.browser]) {
    assert.match(browser.browserVersion, /(?:Chrome|Chromium)\//);
    assert.equal(browser.build, 'production-React-isolated-Chromium'); assert.deepEqual(browser.uncaughtErrors, []);
    assert.deepEqual(browser.profiles.map(profile => profile.consumers), [1, 5, 20]);
  }
  assert.equal(report.browser.browserVersion, report.baseline.browser.browserVersion);
  for (const [index, row] of report.browser.profiles.entries()) {
    const n = row.consumers; const old = report.baseline.browser.profiles[index];
    assert.equal(row.refreshes, 100); assert.equal(row.incoherentCommits, 0); assert(row.coherentCommits > 0);
    assert.equal(Object.keys(row.checks).length, 10); assert(Object.values(row.checks).every(value => value === true));
    assert.deepEqual(row.comments, { names: 0, targets: 0, colors: 0, fields: 0, records: 0 });
    assert.deepEqual(row.metrics, { names: 0, targets: 0, colors: 0, fields: n * 100, records: n * 100 });
    assert.deepEqual(row.rename, { names: n, targets: n, colors: 0, fields: n, records: n });
    assert.deepEqual(row.membership, { names: 0, targets: 0, colors: n, fields: n, records: 0 });
    assert.deepEqual(row.generationChange, { names: n, targets: n, colors: 0, fields: n, records: n });
    assert.deepEqual(row.failure, { names: 0, targets: 0, colors: 0, fields: 0, records: 0 });
    assert.equal(old.comments.names, n * 100); assert.equal(old.comments.targets, n * 100);
    assert.equal(old.metrics.names, n * 100); assert.equal(old.metrics.targets, n * 100);
    assert.equal(old.rename.names, n * 2); assert.equal(old.checks.changedGenerationReleasesRecords, false);
  }
  assert.deepEqual(report.acceptance, { sqlite: 'real-temporary-WAL-FULL-product-migrations', browser: 'actual-hooks-synthetic-complete-publications', fullProvider: 'not-run', native: 'not-run', deviceBudget: 'not-evaluated' });
}
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validate(report); assert.equal(report.source.fingerprint, fingerprint(), 'Generation evidence is stale.');
  console.log('Workspace generation evidence matches source: 38 checks and three mounted React groups with identical baseline probes.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-generation-acceptance-')); const baseline = path.join(temporary, 'baseline'); let added = false;
  const before = fingerprint(); const commit = git('rev-parse', 'HEAD');
  const baseRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11) ?? (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).baseline.commit : commit);
  const baselineCommit = git('rev-parse', baseRef);
  function run(directory, files, name, status) {
    const file = path.join(temporary, `${name}.json`); const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...files, '--reporter=json', `--outputFile=${file}`], { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error; assert.equal(result.status, status, result.stdout + result.stderr);
    const data = JSON.parse(readFileSync(file, 'utf8')); assert.equal(data.numPendingTests, 0);
    assert.deepEqual(data.testResults.map(suite => path.relative(realpathSync(directory), realpathSync(suite.name))).sort(), [...files].sort());
    return data.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, title: test.title, status: test.status, durationMs: test.duration ?? 0 })));
  }
  function browser(directory, name) {
    const file = path.join(temporary, `${name}.json`); const result = spawnSync('node', [browserFiles[0], `--output=${file}`], { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error; assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(readFileSync(file, 'utf8'));
  }
  try {
    git('worktree', 'add', '--detach', baseline, baselineCommit); added = true;
    for (const file of [integration, ...browserFiles]) cpSync(path.join(root, file), path.join(baseline, file));
    symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const baselineTests = run(baseline, [integration], 'baseline-tests', 1); const baselineBrowser = browser(baseline, 'baseline-browser');
    const tests = run(root, suites, 'current-tests', 0); const currentBrowser = browser(root, 'current-browser');
    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    const report = { kind: 'workspace_projection_generation_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: before }, environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      suites, tests, browser: currentBrowser, baseline: { commit: baselineCommit, testSha256: hash(readFileSync(path.join(root, integration))), tests: baselineTests, browser: baselineBrowser },
      acceptance: { sqlite: 'real-temporary-WAL-FULL-product-migrations', browser: 'actual-hooks-synthetic-complete-publications', fullProvider: 'not-run', native: 'not-run', deviceBudget: 'not-evaluated' } };
    validate(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Workspace generation acceptance: baseline seven failures -> zero; 38 current checks and 1/5/20 consumer browser groups passed.');
  } finally { if (added) git('worktree', 'remove', '--force', baseline); rmSync(temporary, { recursive: true, force: true }); }
}
