import assert from 'node:assert/strict';
export function validateShelfStatsReport(report) {
  assert.equal(report.kind, 'shelf_stats_acceptance'); assert.equal(report.schemaVersion, 1); assert.equal(report.status, 'passed');
  assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/); assert.match(report.baseline.functionSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.fixture.synthetic, true); assert.equal(report.fixture.database, 'temporary-file-WAL-FULL-product-migrations');
  assert.equal(report.fixture.integrity, 'ok'); assert.equal(report.fixture.foreignKeys, 'ok');
  assert.deepEqual(report.profiles.map(p => p.nodes), [100, 1000, 5000, 40000]);
  for (const profile of report.profiles.slice(0, 3)) {
    assert.equal(profile.baseline.length, 5); assert.equal(profile.current.length, 5);
    for (let i = 0; i < 5; i++) {
      const old = profile.baseline[i]; const current = profile.current[i];
      assert.deepEqual(current.stats, old.stats); assert.equal(current.stats.nodes, profile.nodes);
      assert.equal(current.stats.words, (profile.nodes - 2) * 3); assert.equal(current.stats.wordsReady, true);
      assert.equal(old.queries, 7); assert(old.returnedRows >= profile.nodes); assert.equal(old.maxParameters, profile.nodes);
      assert.equal(current.queries, 1); assert.equal(current.returnedRows, 1); assert.equal(current.maxParameters, 7);
      assert(current.decodedRowJsonBytes < 100); assert(old.decodedRowJsonBytes > current.decodedRowJsonBytes);
      assert(Number.isFinite(current.elapsedMs) && current.elapsedMs > 0); assert(Number.isFinite(old.elapsedMs) && old.elapsedMs > 0);
    }
  }
  const large = report.profiles[3];
  assert.equal(large.current.stats.nodes, 40000); assert.equal(large.current.stats.words, 119994);
  assert.equal(large.current.queries, 1); assert.equal(large.current.returnedRows, 1); assert.equal(large.current.maxParameters, 7);
  assert.equal(large.baselineFailure, 'too many SQL variables'); assert(large.queryPlan.length > 0);
  assert.equal(report.tests.length, 6); assert(report.tests.every(test => test.status === 'passed'));
  assert.equal(report.acceptance.native, 'not-run'); assert.equal(report.acceptance.startupImprovement, 'not-evaluated'); assert.equal(report.acceptance.deviceBudget, 'not-evaluated');
}
