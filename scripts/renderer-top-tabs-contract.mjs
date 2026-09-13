import assert from 'node:assert/strict';

export function validateTopTabsAcceptance(report) {
  assert.equal(report.kind, 'top_tab_presentation_acceptance'); assert.equal(report.status, 'passed');
  for (const sha of [report.source.commit, report.baseline.commit]) assert.match(sha, /^[a-f0-9]{40}$/);
  for (const sha of [report.source.fingerprint, report.baseline.scenarioSha256]) assert.match(sha, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.suites, ['src/renderer/components/topBars/TopTimeline/top-tab-presentation.test.ts', 'src/renderer/store/ui-store.workspace-tabs.test.ts', 'src/renderer/shells/desktop/navigation/desktop-tab-close-transition.acceptance.test.ts', 'src/renderer/shells/desktop/entity-create/desktop-universal-create.acceptance.test.ts', 'src/renderer/components/topBars/TopTimeline/create-return.acceptance.test.ts']);
  assert.equal(report.tests.length, 37); assert.equal(new Set(report.tests.map(test => test.name)).size, 37);
  assert(report.tests.every(test => test.status === 'passed' && Number.isFinite(test.durationMs) && test.durationMs >= 0));
  for (const browser of [report.browser, report.baseline.browser]) {
    assert.equal(browser.build, 'production-React-mounted-top-tab-strip-Chromium');
    assert.match(browser.browserVersion, /(?:Chrome|Chromium)\//); assert.deepEqual(browser.uncaughtErrors, []);
    assert.deepEqual(browser.profiles.map(row => [row.nodes, row.tabCount]), [100, 1000, 5000].flatMap(n => [1, 5, 20].map(t => [n, t])));
  }
  assert.equal(report.browser.browserVersion, report.baseline.browser.browserVersion);
  const zero = { renders: 0, measurements: 0, scrollChecks: 0, arrayVisits: 0, indexRows: 0, projectedLeaves: 0 };
  for (const [index, row] of report.browser.profiles.entries()) {
    const old = report.baseline.browser.profiles[index]; const n = row.nodes; const t = row.tabCount;
    assert.equal(row.updates, 100);
    const visitsPerPass = 4 * (t * (2 * n - t + 1) / 2) + t;
    assert.deepEqual(row.metrics, { ...zero, indexRows: n * 100, projectedLeaves: t * 100 });
    assert.deepEqual(old.metrics, { ...zero, renders: 100, measurements: t * 100, scrollChecks: 100, arrayVisits: visitsPerPass * 100 });
    assert.deepEqual(row.unrelatedBodies, { ...zero, projectedLeaves: t * 10 });
    assert.deepEqual(old.unrelatedBodies, { ...zero, renders: 10, measurements: t * 10, scrollChecks: 10, arrayVisits: visitsPerPass * 10 });
    assert.deepEqual(row.outsideRename, { ...zero, indexRows: n, projectedLeaves: t });
    assert.deepEqual(row.colorChange, { ...zero, renders: 1, indexRows: 2, projectedLeaves: t });
    assert.equal(old.colorChange.measurements, t); assert.equal(old.colorChange.scrollChecks, 1);
    assert.deepEqual(row.rename, { ...zero, renders: 1, measurements: t, scrollChecks: 1, indexRows: n, projectedLeaves: t });
    assert.deepEqual(row.generationChange, { ...zero, renders: 1, measurements: t, scrollChecks: 1, indexRows: n + 2, projectedLeaves: t });
    assert.deepEqual(row.requestOnly, zero); assert.deepEqual(row.unmounted, zero);
    for (const key of ['initialWidths', 'renameWidths', 'narrowWidths', 'splitWidths']) {
      assert.deepEqual(row[key], old[key], `${key} changed from the baseline.`);
      assert(row[key].every(width => Number.isFinite(width) && width > 0));
      assert.equal(row[key].length, key === 'splitWidths' ? 2 : t);
    }
    assert.equal(Object.keys(row.checks).length, 15);
    for (const [key, passed] of Object.entries(row.checks)) assert.equal(passed, key === 'reorderWorks' && t === 1 ? null : true, key);
    assert.equal(old.checks.foreignHidden, false);
    if (t === 1) assert.equal(row.dragWork, null);
    else { assert.equal(row.dragWork.arrayVisits, 0); assert(old.dragWork.arrayVisits > 0); assert.deepEqual(row.dragTrace.ordered, old.dragTrace.ordered); }
  }
  assert.deepEqual(report.acceptance, { browser: 'actual-top-tab-strip-synthetic-shell-adapters-and-complete-publications', dataWrites: 'none', native: 'not-run', deviceBudget: 'not-evaluated' });
}
