import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { nativePerformanceSourceFingerprint } from './native-performance-audit-plugin.mjs';
import { rendererSourceFingerprint } from './renderer-performance-source.mjs';
const directory = 'docs/renderer-performance/acceptance';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const paths = { browser: `${directory}/heavy-workflow-surface-containment.json`, before: `${directory}/yjs-durability-before.json`, after: `${directory}/yjs-durability-after.json`,
  native: `${directory}/yjs-durability-native-audit.json`, idle: `${directory}/yjs-durability-native-idle.json`,
  persistence: `${directory}/yjs-durability-native-persistence.json`, tests: '.local-data/heavy-workflow/tests.json' };
const before = read(paths.before), after = read(paths.after), native = read(paths.native), idle = read(paths.idle), persistence = read(paths.persistence), tests = read(paths.tests);
const browser = read(paths.browser);
assert.equal(browser.source.rendererFingerprint, rendererSourceFingerprint(process.cwd()));
assert.equal(browser.surfaceContainment.checks.length, 9);
const fingerprint = nativePerformanceSourceFingerprint(process.cwd()).fingerprint;
assert.equal(native.source.fingerprint, fingerprint); assert.equal(idle.fingerprint, fingerprint);
const cpuSource = createHash('sha256').update(readFileSync('src/renderer/services/yjs-document-session.ts')).update(readFileSync('scripts/measure-yjs-durability.ts')).digest('hex');
assert.equal(after.source, cpuSource); assert.equal(after.recovered, 25);
const phase = (report, name) => report.phases.find(row => row.name === name);
assert.equal(phase(before, 'twenty-idle-project-barriers').snapshots, 500);
assert.equal(phase(after, 'twenty-idle-project-barriers').snapshots, 0);
assert.equal(phase(after, 'one-edited-document-project-barrier').snapshots, 1);
assert.equal(phase(after, 'twenty-barriers-after-save').snapshots, 0);
assert.equal(idle.changedSnapshots, 0); assert(Object.values(idle.checks).every(Boolean));
assert(Object.values(persistence.checks).every(Boolean)); assert.equal(persistence.watchdog.stalls.length, 0);
for (const marker of ['durability-25-tabs', 'durability-idle-saves', 'durability-write', 'durability-close', 'durability-reopen']) {
  const row = native.phases.find(row => row.marker === marker);
  assert(row?.comparableSamples > 0, `Missing visible phase ${marker}`); assert.equal(row.commitErrors, 0); assert.equal(row.errors.length, 0);
}
assert.equal(native.phases.find(row => row.marker === 'durability-idle-saves').dom.maxEditors, 25);
assert.equal(native.phases.find(row => row.marker === 'durability-close').dom.last.editors, 0);
assert.equal(tests.success, true); assert.equal(tests.numFailedTests, 0);
const hashes = Object.fromEntries(Object.entries(paths).map(([key, file]) => [key, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const report = { kind: 'heavy_workflow_incremental_acceptance', generatedAt: new Date().toISOString(), fingerprint, status: 'passed-scoped-a1-b1-checks',
  checks: { sourceMatched: true, noSyntheticIdleSnapshotEncodingOrWrite: true, oneDirtyDocumentOneSnapshot: true, nativeIdleSnapshotsUnchanged: true,
    canonicalRecovery: true, noObservedNativeStallOrJsErrorInFinalRun: true, retainedViewContainment: true, twentyFiveEditorsReleased: true, fullTests: true },
  tests: { passed: tests.numPassedTests, skipped: tests.numPendingTests, failed: tests.numFailedTests }, evidenceSha256: hashes,
  knownOpenIssues: ['Native passes captured RangeError without a usable source stack, including the later merged UI smoke run. Its cause remains open.'],
  scope: 'A1 snapshot reuse and B1 retained-view containment only. Other architecture stages and product interaction budgets are not accepted by this report.' };
const output = `${directory}/heavy-workflow-incremental-acceptance.json`;
if (process.argv.includes('--check')) { const saved = read(output); assert.equal(saved.fingerprint, fingerprint); assert.deepEqual(saved.evidenceSha256, hashes); }
else writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, tests: report.tests }));
