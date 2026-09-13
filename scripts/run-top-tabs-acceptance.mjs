import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';
import { validateTopTabsAcceptance } from './renderer-top-tabs-contract.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const suites = ['src/renderer/components/topBars/TopTimeline/top-tab-presentation.test.ts', 'src/renderer/store/ui-store.workspace-tabs.test.ts', 'src/renderer/shells/desktop/navigation/desktop-tab-close-transition.acceptance.test.ts', 'src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts', 'src/renderer/components/topBars/TopTimeline/create-return.acceptance.test.ts'];
const browserFiles = ['scripts/run-top-tabs-browser.mjs', 'scripts/renderer-top-tabs.html', 'src/renderer/performance/top-tab-presentation-scenario.tsx'];
const harnessFiles = [...browserFiles, 'scripts/run-top-tabs-acceptance.mjs', 'scripts/renderer-top-tabs-contract.mjs'];
const output = path.join(root, 'docs/renderer-performance/acceptance/f2-top-tabs.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(rendererSourceFingerprint(root) + harnessFiles.map(file => readFileSync(path.join(root, file), 'utf8')).join('\0'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (process.argv.includes('--check')) {
  const report = JSON.parse(readFileSync(output, 'utf8')); validateTopTabsAcceptance(report);
  assert.equal(report.source.fingerprint, fingerprint(), 'Top tab evidence is stale.');
  console.log('Top tab evidence matches current source and acceptance harness.');
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'drifting-search-acceptance-')); const baseline = path.join(temporary, 'baseline'); let added = false;
  const before = fingerprint(); const commit = git('rev-parse', 'HEAD');
  const baseRef = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11) ?? (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')).baseline.commit : commit);
  const baselineCommit = git('rev-parse', baseRef);
  function browser(directory, name) {
    const file = path.join(temporary, `${name}.json`); const result = spawnSync('node', [browserFiles[0], `--output=${file}`], { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error; assert.equal(result.status, 0, result.stdout + result.stderr); return JSON.parse(readFileSync(file, 'utf8'));
  }
  try {
    git('worktree', 'add', '--detach', baseline, baselineCommit); added = true;
    for (const file of browserFiles) cpSync(path.join(root, file), path.join(baseline, file));
    symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
    const oldBrowser = browser(baseline, 'baseline-browser'); console.log('Identical baseline browser scenario captured.');
    const currentBrowser = browser(root, 'current-browser'); console.log('Current browser scenario captured.');
    const file = path.join(temporary, 'tests.json');
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites, '--reporter=json', `--outputFile=${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (run.error) throw run.error; assert.equal(run.status, 0, run.stdout + run.stderr);
    const data = JSON.parse(readFileSync(file, 'utf8')); assert.equal(data.numPendingTests, 0);
    const tests = data.testResults.flatMap(suite => suite.assertionResults.map(test => ({ name: test.fullName, status: test.status, durationMs: test.duration ?? 0 })));
    assert.equal(before, fingerprint(), 'Source changed during acceptance.');
    const report = { kind: 'top_tab_presentation_acceptance', status: 'passed', generatedAt: new Date().toISOString(),
      source: { commit, fingerprint: before }, environment: { platform: platform(), release: release(), node: process.version, sqlite: process.versions.sqlite },
      suites, tests, browser: currentBrowser, baseline: { commit: baselineCommit,
        scenarioSha256: hash(readFileSync(path.join(root, browserFiles[2]))), browser: oldBrowser },
      acceptance: { browser: 'actual-top-tab-strip-synthetic-shell-adapters-and-complete-publications', dataWrites: 'none', native: 'not-run', deviceBudget: 'not-evaluated' } };
    validateTopTabsAcceptance(report); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log('Top tab acceptance captured: semantic projection, workspace tab regression and identical mounted browser baseline.');
  } finally { if (added) git('worktree', 'remove', '--force', baseline); rmSync(temporary, { recursive: true, force: true }); }
}
