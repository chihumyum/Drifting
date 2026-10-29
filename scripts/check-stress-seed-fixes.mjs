// Summarize measured acceptance only; no UI actions or invented timings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { nativePerformanceSourceFingerprint } from './native-performance-audit-plugin.mjs';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';

const root = process.cwd();
const directory = 'docs/renderer-performance/acceptance';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const paths = {
  native: `${directory}/stress-seed-native-after-fixes.json`,
  persistence: `${directory}/stress-seed-persistence-after-fixes.json`,
  browser: `${directory}/stress-seed-agent-after-fixes.json`,
  node: `${directory}/stress-seed-node-diagnostic.json`,
  tests: '.local-data/native-performance-audit/fixes-tests.json',
};
const native = read(paths.native), persistence = read(paths.persistence), browser = read(paths.browser), tests = read(paths.tests);
assert.equal(native.source.fingerprint, nativePerformanceSourceFingerprint(root).fingerprint, 'Native evidence source changed');
assert.equal(browser.source.rendererFingerprint, rendererSourceFingerprint(root), 'Browser evidence source changed');
assert.equal(tests.success, true); assert.equal(tests.numFailedTests, 0);
assert(Object.values(persistence.checks).every(Boolean));
assert.equal(persistence.checks.workerProjectionPostFixWrite, true);
assert.equal(persistence.watchdog.stalls.length, 0, 'Review the new native stalls before accepting');
assert.equal(browser.status, 'measured');
assert.equal(browser.kind, 'renderer_agent_panel_run');
assert.equal(browser.agentPanel.historyWindowing.offlineHistory, true);
assert.equal(browser.agentPanel.historyWindowing.allHistoryReachable, true);
assert(browser.agentPanel.historyWindowing.initialAssistantNodes <= 64);
const required = ['fixes-material', 'fixes-search', 'fixes-agent-history', 'fixes-write-50k', 'fixes-switch-25-tabs', 'fixes-sidebar-timeline', 'fixes-close-tabs'];
for (const marker of required) {
  const phase = native.phases.find(phase => phase.marker === marker);
  assert(phase?.comparableSamples > 0, `Missing visible comparable phase: ${marker}`);
  assert.equal(phase.errors.length, 0); assert.equal(phase.commitErrors, 0);
}
const phase = marker => native.phases.find(phase => phase.marker === marker);
assert.equal(phase('fixes-switch-25-tabs').dom.maxEditors, 25);
assert.equal(phase('fixes-close-tabs').dom.last.editors, 0);
const report = { kind: 'stress_seed_fix_acceptance', generatedAt: new Date().toISOString(), status: 'passed-scoped-fix-checks',
  source: native.source, evidenceSha256: Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, digest(file)])),
  checks: { sourceMatched: true, fullTests: true, workerProjectionAndYjsDurable: true, noNewNativeWatchdogStall: true,
    visiblePhaseCoverage: true, noObservedJsOrCommitError: true, twentyFiveEditorsReleased: true, offlineHistoryAndBoundedEntry: true },
  tests: { passed: tests.numPassedTests, skipped: tests.numPendingTests, failed: tests.numFailedTests },
  phases: required.map(marker => { const row = phase(marker); return { marker, comparableSamples: row.comparableSamples,
    maxFrameGapMs: row.metrics.frameGaps.max, maxReactRenderMs: row.metrics.reactCommits.max, dom: row.dom, components: row.components }; }),
  limitations: ['Debug/Strict Mode/native AX overhead; historical before and current after are separate observation sessions, not a controlled release speedup.',
    'RSS is not a retained heap graph. Editors deliberately retain undo and Yjs until tabs close. Earlier Agent messages are loaded on request.',
    'No compositor repaint, forced-layout count, real model call, native IME, full import/recovery or multi-hour soak acceptance.'] };
if (process.argv.includes('--check')) {
  const saved = read(`${directory}/stress-seed-fix-acceptance.json`);
  assert.deepEqual(saved.evidenceSha256, report.evidenceSha256);
  assert.equal(saved.source.fingerprint, report.source.fingerprint);
} else writeFileSync(`${directory}/stress-seed-fix-acceptance.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, tests: report.tests, phases: report.phases.length }));
