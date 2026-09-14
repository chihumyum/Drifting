import { featureLoadingClosure } from './renderer-feature-loading-closure.mjs';
import assert from 'node:assert/strict';
export const projectRouteChecks = ['coldUntilDemand', 'sharedJsFailure', 'cssFailure', 'backAfterFailure', 'reloadRetry', 'loadingBack', 'lateProjectOwner', 'routeTable', 'draftContinuity', 'cachedReopen', 'standaloneSettings'];
export function validateProjectRoutes(report) {
  assert.equal(report.kind, 'renderer_deferred_project_routes'); assert.equal(report.status, 'passed');
  assert.equal(report.before.source.commit, 'c290c9981e8255055624adccf669fd4515c2647f');
  for (const [stage, eager] of [['before', true], ['after', false]]) {
    const data = report[stage]; assert.match(data.source.fingerprint, /^[a-f0-9]{64}$/);
    const initial = new Set();
    const visit = file => { if (initial.has(file)) return; initial.add(file); const chunk = data.chunks.find(item => item.file === file); assert(chunk); chunk.imports.forEach(visit); };
    data.chunks.filter(chunk => chunk.htmlEntry).forEach(chunk => visit(chunk.file));
    assert.equal(data.initialJsBytes, data.chunks.filter(chunk => initial.has(chunk.file)).reduce((sum, chunk) => sum + chunk.bytes, 0));
    for (const chunk of data.chunks) assert.equal(chunk.initial, initial.has(chunk.file));
    for (const target of ['desktopShell', 'mobileShell', 'editorRoutes', 'dashboard']) {
      const chunks = data.chunks.filter(chunk => chunk.targets.includes(target)); assert.equal(chunks.length, 1);
      assert.equal(chunks[0].initial, eager);
      for (const observed of ['requested', 'parsed']) assert.equal(data.initial[observed].includes(chunks[0].file), eager);
      assert.equal(data.initial.evaluated.includes(target), eager);
    }
  }
  const available = featureLoadingClosure(report.after.chunks);
  const features = report.after.chunks.filter(chunk => /(?:settings-panels|graph-ui|story-graph|element-graph|memo-material)-/.test(chunk.file));
  assert.equal(features.length, 5);
  for (const feature of features) {
    assert(!feature.initial);
    for (const file of feature.imports) assert(available.files.has(file), `Unowned feature dependency: ${file}`);
    for (const css of feature.css) assert(available.css.has(css), `Unloaded feature CSS: ${css}`);
  }
  assert(report.after.initialJsBytes < report.before.initialJsBytes);
  assert.deepEqual(Object.keys(report.after.checks).sort(), [...projectRouteChecks].sort());
  for (const check of projectRouteChecks) assert.equal(report.after.checks[check], true, check);
  assert.equal(report.after.failures.length, 2);
  for (const kind of ['shared-js', 'css']) {
    const failure = report.after.failures.find(item => item.kind === kind); assert(failure);
    assert.equal(failure.workspacesBeforeRetry, 0); assert.equal(failure.afterRetryProject, 'synthetic-a');
    assert(failure.requestedAfterRetry.includes(failure.file));
  }
  assert.deepEqual(report.acceptance, { productionModuleLoading: 'passed', syntheticRouteOwnership: 'passed', nativeOrDevice: 'not-run', wholeAppStartup: 'not-measured', fixedDeviceBudgets: 'not-measured' });
}
