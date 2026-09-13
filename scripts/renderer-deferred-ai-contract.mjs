import assert from 'node:assert/strict';
export const aiBrowserChecks = ['constructionIsDeferred', 'openaiFailureSurfaced', 'openaiRetryNewKey', 'openaiCancelIsolated', 'openaiSnapshotPreserved', 'googleFailureSurfaced', 'googleRetryNewKey', 'googleCancelIsolated', 'offlineDuringGoogleLoad', 'googleSnapshotPreserved', 'factoryCompletion', 'allStreams', 'cachedReuse', 'oneSdkEvaluation'];
export function validateDeferredAI(report) {
  assert.equal(report.kind, 'renderer_deferred_ai_providers'); assert.equal(report.status, 'passed');
  assert.equal(report.before.source.commit, '8f17a6c5963533ea65454d62dbbf33d8ed7e4d6f');
  for (const [stage, eager] of [['before', true], ['after', false]]) {
    const data = report[stage]; assert.match(data.source.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(data.initialJsBytes, data.chunks.filter(chunk => chunk.initial).reduce((sum, chunk) => sum + chunk.bytes, 0));
    for (const target of ['openai', 'google']) {
      const sdk = data.chunks.filter(chunk => chunk.targets.includes(target)); assert.equal(sdk.length, 1);
      assert.equal(sdk[0].initial, eager); assert.equal(data.initial.evaluated.includes(target), eager);
      assert.equal(data.initial.parsed.includes(sdk[0].file), eager); assert.equal(data.initial.requested.includes(sdk[0].file), eager);
      if (!eager) for (const imported of sdk[0].imports) assert(data.chunks.some(chunk => chunk.file === imported && chunk.initial), `Unretryable cold dependency: ${imported}`);
    }
    assert.equal(data.completions.length, 3); assert(data.completions.every(result => result.text === 'OK' && result.usage.inputTokens === 3));
    assert.equal(data.streams.length, 3); assert(data.streams.every(result => result.status === 'passed' && result.result.map(chunk => chunk.delta).join('') === 'OK'));
  }
  assert(report.after.initialJsBytes < report.before.initialJsBytes);
  assert.deepEqual(Object.keys(report.after.checks).sort(), [...aiBrowserChecks].sort());
  for (const key of aiBrowserChecks) assert.equal(report.after.checks[key], true, key);
  assert.equal(report.after.moduleRequests.length, 4);
  for (const key of ['openai', 'google']) {
    const requests = report.after.moduleRequests.filter(request => request.kind === key); assert.equal(requests.length, 2);
    assert.notEqual(requests[0].url, requests[1].url); assert.equal(requests[0].url.split('?')[0], requests[1].url.split('?')[0]);
    assert(requests.every(request => request.url.includes('provider-attempt=')));
  }
  assert.equal(report.adapters.length, 3); assert(report.adapters.every(item => /^[a-f0-9]{64}$/.test(item.before) && item.before === item.after));
  assert(report.tests.length >= 30); assert(report.tests.every(test => test.status === 'passed'));
  assert.deepEqual(report.acceptance, { productionModuleLoading: 'passed', syntheticProviderTransport: 'passed', cancellationAndRetry: 'passed', nativeOrDevice: 'not-run', liveProvider: 'not-run', wholeAppStartup: 'not-measured' });
}
