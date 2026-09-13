import assert from 'node:assert/strict';

export function validateGlobalSearchAcceptance(report) {
  assert.equal(report.kind, 'global_search_session_acceptance'); assert.equal(report.status, 'passed');
  assert.match(report.source.commit, /^[a-f0-9]{40}$/); assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(report.baseline.commit, /^[a-f0-9]{40}$/); assert.match(report.baseline.scenarioSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.suites, ['src/renderer/components/search/global-search-model.test.ts', 'src/renderer/components/search/global-search-repository.integration.test.ts']);
  assert.equal(report.tests.length, 14); assert.equal(new Set(report.tests.map(test => test.name)).size, 14);
  assert(report.tests.every(test => test.status === 'passed' && Number.isFinite(test.durationMs) && test.durationMs >= 0));
  for (const browser of [report.browser, report.baseline.browser]) {
    assert.match(browser.browserVersion, /(?:Chrome|Chromium)\//);
    assert.equal(browser.build, 'production-React-mounted-global-search-Chromium'); assert.deepEqual(browser.uncaughtErrors, []);
    assert.deepEqual(browser.profiles.map(profile => profile.elements), [100, 1000, 5000]);
  }
  assert.equal(report.browser.browserVersion, report.baseline.browser.browserVersion);
  for (const [index, row] of report.browser.profiles.entries()) {
    const n = row.elements; const old = report.baseline.browser.profiles[index];
    const full = { reads: 1, parses: n, groups: n + 1 }; const zero = { reads: 0, parses: 0, groups: 0 };
    assert.deepEqual(row.initial, full); assert.deepEqual(old.initial, full);
    assert.deepEqual(row.repeatedQueries, { reads: 2, parses: 0, groups: (n + 1) * 2 });
    assert.deepEqual(old.repeatedQueries, { reads: 2, parses: n * 2, groups: (n + 1) * 2 });
    assert.deepEqual(row.rename, { reads: 1, parses: 0, groups: n + 1 }); assert.deepEqual(old.rename, full);
    assert.deepEqual(row.changedBody, { reads: 1, parses: 1, groups: n + 1 }); assert.deepEqual(old.changedBody, full);
    assert.deepEqual(row.generationChange, full); assert.deepEqual(row.reopened, full);
    assert.deepEqual(row.hidden, zero); assert.deepEqual(old.hidden, { reads: 10, parses: n * 10, groups: (n + 1) * 10 });
    assert.deepEqual(row.lateClosedRejection, zero); assert.deepEqual(old.lateClosedRejection, { reads: 0, parses: n, groups: n + 1 });
    assert.deepEqual(row.lateProjectReply, zero); assert.equal(old.checks.projectReturnClearsQuery, false);
    assert.deepEqual(row.lateGenerationRejection, zero); assert.equal(old.lateGenerationRejection.parses, n);
    assert.deepEqual(row.databaseReplacement, { ...zero, hidesOldResults: true });
    assert.deepEqual(row.loading, zero);
    assert.deepEqual(row.newGeneration, { reads: 0, parses: n, groups: n + 1 });
    assert.equal(Object.keys(row.checks).length, 15); assert(Object.values(row.checks).every(value => value === true));
    assert.equal(old.checks.generationHidesOldResults, false); assert.equal(old.checks.generationCannotOpenOldResult, false);
    assert(row.databaseScope.readsObserved > 0); assert.equal(row.databaseScope.allProjectScoped, true); assert.equal(old.databaseScope.allProjectScoped, false);
  }
  assert.deepEqual(report.acceptance, { sqlite: 'real-temporary-WAL-FULL-product-migrations', browser: 'actual-modal-synthetic-async-database-port', native: 'not-run', deviceBudget: 'not-evaluated', liveYjsSearch: 'existing-persisted-cache-semantics' });
}
