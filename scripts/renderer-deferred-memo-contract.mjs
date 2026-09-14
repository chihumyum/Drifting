import { featureLoadingClosure } from './renderer-feature-loading-closure.mjs';
import assert from 'node:assert/strict';
export const memoChecks = ['initiallyDeferred', 'failedLocally', 'retryNewKey', 'canceledOpenStaysClosed', 'editorPreserved', 'cachedReopen', 'actualMaterials', 'queryFilters', 'composeEscapeKeepsView', 'projectIsolated', 'backAccepted', 'noGraphRequested'];
export function validateDeferredMemoEvidence(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'renderer_deferred_memo'); assert.equal(report.status, 'passed');
  assert.equal(report.before.source.commit, '96795513615124cab9ea8c09315516bf698ab1b0');
  for (const [stage, expected] of [['before', true], ['after', false]]) {
    const data = report[stage]; assert.match(data.source.fingerprint, /^[a-f0-9]{64}$/);
    const memo = data.chunks.filter(c => c.targets.includes('memo')); assert.equal(memo.length, 1);
    assert.equal(memo[0].initial, expected);
    assert.equal(data.initial.evaluated.includes('memo'), expected);
    assert.equal(data.initial.parsed.includes(memo[0].file), expected);
    assert.equal(data.initial.requested.includes(memo[0].file), expected);
    assert.equal(data.initialJsBytes, data.chunks.filter(c => c.initial).reduce((sum, c) => sum + c.bytes, 0));
    for (const name of ['graph', 'element', 'shared']) assert.equal(data.initial.evaluated.includes(name), false);
    if (!expected) {
      for (const imported of memo[0].imports) assert(featureLoadingClosure(data.chunks).files.has(imported), `Cold dependency: ${imported}`);
      const initialCss = featureLoadingClosure(data.chunks).css;
      for (const css of memo[0].css) assert(initialCss.has(css), `Unloaded CSS: ${css}`);
    }
  }
  assert(report.after.initialJsBytes < report.before.initialJsBytes);
  assert.deepEqual(report.ui.map(ui => ui.shell), ['desktop', 'mobile']);
  for (const ui of report.ui) {
    for (const key of memoChecks) assert.equal(ui.checks[key], true, `${ui.shell}: ${key}`);
    assert.deepEqual(ui.uncaughtErrors, []); assert.equal(ui.requests.length, 2);
    assert(ui.requests.every(r => r.kind === 'memo' && r.url.includes('view-attempt=')));
    assert.notEqual(ui.requests[0].url, ui.requests[1].url);
    assert.equal(ui.requests[0].url.split('?')[0], ui.requests[1].url.split('?')[0]);
  }
  assert.equal(report.preload.invisibleFailure, true); assert.equal(report.preload.demandRecovered, true);
  assert.equal(report.preload.requests.length, 2); assert.notEqual(...report.preload.requests);
  assert.equal(report.lateProject.currentDataOnly, true); assert.equal(report.lateProject.focusTransferred, true);
  assert.equal(report.dev, 'passed');
  assert.equal(report.acceptance.native, 'not-run'); assert.equal(report.acceptance.fullAppStartup, 'not-run');
}
