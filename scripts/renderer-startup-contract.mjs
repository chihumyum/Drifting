import assert from 'node:assert/strict';
export const startupRepetitions = 6;
export const startupMetrics = ['launchToShelfMs', 'projectOpenMs', 'first50kOpenMs', 'small5kOpenMs', 'bootstrapMs', 'projectionCaptureMs'];
export function summarizeStartupRuns(runs) {
  return Object.fromEntries(startupMetrics.map(metric => {
    const values = runs.slice(1).map(run => run.metrics[metric]).sort((a,b) => a-b);
    return [metric, { samples: values.length, median: values[Math.floor(values.length/2)], p95: values[Math.ceil(values.length*0.95)-1], min: values[0], max: values.at(-1) }];
  }));
}
export function validateStartupReport(report) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.interLaunchDelayMs, 1500);
  assert.equal(report.kind, 'renderer_native_startup'); assert.equal(report.status, 'passed');
  assert.equal(report.runs.length, startupRepetitions); assert.equal(report.warmupRuns, 1);
  assert.match(report.source.fingerprint, /^[a-f0-9]{64}$/); assert.match(report.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.artifact.build, 'packaged-release-production-renderer'); assert.equal(report.artifact.signed, false);
  assert.equal(report.fixture.reproducible, true); assert.equal(report.fixture.freshCopyPerLaunch, true);
  assert.equal(report.fixture.specification.firstEditorCharacters, 50000);
  for (const [index, run] of report.runs.entries()) {
    assert.equal(run.index, index); assert.equal(run.status, 'passed');
    assert.equal(run.launcherExitCode, 0); assert.equal(run.nativeProcessExited, true); assert.equal(run.nativeExitCode, null);
    assert.equal(run.focused, true); assert.equal(run.visible, true); assert.deepEqual(run.failures, []);
    assert.equal(run.unchangedChapters, 53); assert.equal(run.proseUnchanged, true);
    assert.equal(run.integrityCheck, 'ok'); assert.equal(run.foreignKeyCheck, 'ok');
    assert.deepEqual(run.editorTrials.map(t=>t.characters),[50000,5000]);
    for(const trial of run.editorTrials) { assert.equal(trial.canonicalYjs,true); assert.equal(trial.focused,true); assert(trial.readyMs>trial.requestedMs); }
    for (const metric of startupMetrics) assert(Number.isFinite(run.metrics[metric]) && run.metrics[metric] > 0, metric);
    assert.equal(run.metrics.projectOpenMs, run.projectReadyMs-run.projectRequestedMs);
    assert.equal(run.metrics.first50kOpenMs, run.editorTrials[0].readyMs-run.editorTrials[0].requestedMs);
    assert.equal(run.metrics.small5kOpenMs, run.editorTrials[1].readyMs-run.editorTrials[1].requestedMs);
    assert.equal(run.metrics.launchToShelfMs, run.timeOrigin+run.shelfReadyMs-run.launchRequestedAt);
    assert(run.projectRequestedMs>=run.shelfReadyMs && run.editorTrials[0].requestedMs>=run.projectReadyMs);
    for(const name of ['bootstrap-start','metadata-ready','react-mount-requested','projection-capture-start','projection-capture-ready']) assert.equal(run.marks.filter(m=>m.name===name).length,1,name);
    const at = name => run.marks.find(m=>m.name===name).atMs;
    assert.equal(run.metrics.bootstrapMs, at('metadata-ready')-at('bootstrap-start'));
    assert.equal(run.metrics.projectionCaptureMs, at('projection-capture-ready')-at('projection-capture-start'));
    assert(at('bootstrap-start') >= 0 && at('react-mount-requested') >= at('metadata-ready') && run.shelfReadyMs >= at('react-mount-requested'));
    assert(at('projection-capture-start') >= run.projectRequestedMs && run.projectReadyMs >= at('projection-capture-ready'));
  }
  assert.deepEqual(report.summary,summarizeStartupRuns(report.runs));
  assert.equal(report.acceptance.fixedM1Budget,'not-run'); assert.equal(report.acceptance.coldFilesystem,'not-controlled');
  assert.equal(report.acceptance.physicalIme,'not-run'); assert.equal(report.acceptance.signedRc,'not-run');
}
