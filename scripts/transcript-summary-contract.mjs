import assert from 'node:assert/strict';

export function validateTranscriptSummary(report) {
  assert.equal(report.kind, 'agent_transcript_summary'); assert.equal(report.status, 'passed');
  assert.equal(report.before.commit, '44bdb498043d17991fe4e4d3528afe009d34d932');
  const checks = ['allHistoryMounted', 'historyDomAndSelection', 'toolDomAndExpansion', 'completeTail', 'oldSnapshotUnchanged',
    'canonicalEqualsExpected', 'rebuiltLeavesPreserveDom', 'historicalToolUpdated', 'terminalAndUsagePresent', 'currentEvidenceTarget'].sort();
  for (const stage of ['before', 'after']) {
    const data = report[stage]; assert.match(data.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(data.profiles.map(p => [p.surface, p.history]), ['desktop', 'mobile'].flatMap(surface => [300, 3000, 10000].map(history => [surface, history])));
    for (const p of data.profiles) {
      const after = stage === 'after'; const desktop = p.surface === 'desktop';
      assert.equal(p.updates, 20); assert.equal(p.updateMs.length, 20); assert(p.updateMs.every(value => Number.isFinite(value) && value >= 0));
      assert.match(p.fixtureSha256, /^[a-f0-9]{64}$/); assert.deepEqual(Object.keys(p.checks).sort(), checks); assert(Object.values(p.checks).every(value => value === true));
      const indices = Array.from({ length: p.history }, (_, i) => i);
      const usage = indices.filter(i => i % 97 === 0); const tools = indices.filter(i => i % 97 !== 0 && i % 101 === 63);
      const tailUsage = usage.filter(i => i >= Math.floor(p.history / 64) * 64).length;
      assert.deepEqual(p.work, { arrays: 0, flattenedRows: 0, comparisons: 20 * (p.history % 64 + 1), leaves: 20 * Math.ceil((p.history + 1) / 32),
        classifiedRows: after ? 20 * (p.history % 64 + 1) : 0,
        usageCandidates: after ? 20 * tailUsage : desktop ? 20 * (p.history + 1) : 0,
        evidenceCandidates: desktop ? 0 : 20 * (after ? tools.length : p.history + 1),
        summaryBlocks: after ? 20 * Math.ceil((p.history + 1) / 64) : 0 });
      const expected = { inTok: 0, outTok: 0, cost: 0, tools: tools.length };
      for (const index of usage) { expected.inTok += index + 1 + 2 + 3; expected.outTok += index + 2; expected.cost += (index + 1) / 100000; }
      expected.inTok += 10; expected.outTok += 20; expected.cost += 0.001;
      assert.deepEqual(p.expectedUsage, expected);
      if (desktop) assert.equal(typeof p.usageFooter, 'string'); else assert.equal(p.usageFooter, null);
    }
  }
  for (let i = 0; i < 6; i++) {
    assert.equal(report.before.profiles[i].fixtureSha256, report.after.profiles[i].fixtureSha256);
    assert.equal(report.before.profiles[i].usageFooter, report.after.profiles[i].usageFooter);
  }
  assert.equal(report.tests.length, 16); assert(report.tests.every(test => test.status === 'passed'));
  assert.deepEqual(report.acceptance, { actualDesktopAndMobileViews: 'passed', immutableSnapshotAndFallback: 'passed', headlessOnly: true, nativeAndPhysical: 'not-run', fullAppBudget: 'not-measured' });
}
