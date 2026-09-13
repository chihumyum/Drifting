import assert from 'node:assert/strict';
export function validateTranscriptDisplay(report) {
  assert.equal(report.kind, 'agent_transcript_tree_display'); assert.equal(report.status, 'passed');
  assert.equal(report.before.commit, 'c355d6cfff6e48932cd60d51aff186401bd094f9');
  for (const stage of ['before', 'after']) {
    const data = report[stage]; assert.match(data.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(data.profiles.map(({ surface, history }) => [surface, history]), ['desktop', 'mobile'].flatMap(surface => [300, 3000, 10000].map(history => [surface, history])));
    for (const profile of data.profiles) {
      assert.equal(profile.updates, 20); assert.equal(profile.updateMs.length, 20); assert(profile.updateMs.every(value => Number.isFinite(value) && value >= 0));
      assert.match(profile.fixtureSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(Object.keys(profile.checks).sort(), ['allHistoryMounted', 'historyDomAndSelection', 'toolDomAndExpansion', 'completeTail', 'oldSnapshotUnchanged', 'canonicalEqualsExpected', 'rebuiltLeavesPreserveDom', 'historicalToolUpdated', 'terminalAndUsagePresent'].sort());
      assert(Object.values(profile.checks).every(value => value === true));
      assert.equal(profile.work.arrays, stage === 'before' ? 20 : 0); assert.equal(profile.work.flattenedRows, stage === 'before' ? 20 * (profile.history + 1) : 0);
      assert.equal(profile.work.comparisons, stage === 'before' ? 20 * (profile.history + 1) : 20 * (profile.history % 64 + 1));
      assert.equal(profile.work.leaves, stage === 'before' ? 0 : 20 * Math.ceil((profile.history + 1) / 32));
    }
  }
  assert.deepEqual(report.before.profiles.map(p => p.fixtureSha256), report.after.profiles.map(p => p.fixtureSha256));
  assert.equal(report.tests.length, 38); assert(report.tests.every(test => test.status === 'passed'));
  assert.deepEqual(report.acceptance, { actualDesktopAndMobileViews: 'passed', immutableSnapshotAndFallback: 'passed', headlessOnly: true, nativeAndPhysical: 'not-run', fullAppBudget: 'not-measured' });
}
