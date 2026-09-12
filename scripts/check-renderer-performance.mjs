import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, 'docs/renderer-performance/acceptance');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const plan = read(path.join(directory, 'optimization-plan.json'));
const phases = new Map(plan.phases.map((phase) => [phase.id, phase]));
assert.equal(phases.size, plan.phases.length, 'duplicate phase ID');
assert.equal(new Set(plan.recommendedOrder).size, phases.size, 'invalid phase order');
const visited = new Set();
const criteria = new Set();
for (const id of plan.recommendedOrder) {
  const phase = phases.get(id);
  assert(phase, `unknown phase ${id}`);
  assert(['planned', 'in_progress', 'complete'].includes(phase.status), `invalid status ${id}`);
  assert(phase.dependsOn.every((parent) => visited.has(parent)), `cyclic or out-of-order dependency ${id}`);
  for (const item of phase.acceptance) {
    assert(!criteria.has(item.id) && item.id.startsWith(`${id}-`), `invalid acceptance ID ${item.id}`);
    criteria.add(item.id);
    assert(Array.isArray(item.evidence));
    for (const evidence of item.evidence) {
      assert(typeof evidence === 'string' && evidence.startsWith('docs/renderer-performance/acceptance/'));
      assert(!evidence.split('/').includes('..') && existsSync(path.join(root, evidence)), `missing evidence ${evidence}`);
    }
    if (phase.status === 'complete') {
      assert.equal(item.status, 'passed', `${item.id} has not passed`);
      assert(item.evidence.length > 0, `${item.id} lacks evidence`);
    }
  }
  visited.add(id);
}
if (plan.optimizationImplementationStatus === 'complete') {
  assert(plan.phases.every((phase) => phase.status === 'complete'));
}

const reportPath = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9)
  ?? path.join(directory, 'baseline-editor.json');
const report = read(reportPath);
assert.equal(report.schemaVersion, 1);
assert.equal(report.kind, 'renderer_performance_run');
assert.equal(report.status, 'measured');
assert.match(report.source.commit, /^[0-9a-f]{40}$/);
assert.match(report.source.rendererFingerprint, /^[0-9a-f]{64}$/);
assert(report.limitations.length > 0);
assert(report.scenarios.length > 0);
for (const check of [...(report.behaviorChecks ?? []), ...(report.budgetChecks ?? [])]) {
  assert.equal(check.passed, true, `failed check ${check.id}`);
}
for (const scenario of report.reactSubscriptions ?? []) {
  assert.equal(scenario.unrelated.fields, 0);
  assert.equal(scenario.unrelated.wholeStore, scenario.consumers * scenario.operations);
  assert.equal(scenario.related.fields, scenario.consumers);
  assert.equal(scenario.atomicSnapshot, true);
  assert.equal(scenario.dynamicFieldKeys, true);
}
if (report.semanticSubscriptions) {
  const scenario = report.semanticSubscriptions;
  assert.equal(scenario.metrics.collection, scenario.consumers * scenario.metricUpdates);
  assert.equal(scenario.metrics.names, 0);
  assert.equal(scenario.metrics.colors, 0);
  assert.equal(scenario.rename.names, scenario.consumers);
  assert.equal(scenario.rename.colors, 0);
  assert.equal(scenario.appearance.names, 0);
  assert.equal(scenario.appearance.colors, scenario.consumers);
}
if (report.agentDecorations) {
  const scenario = report.agentDecorations;
  assert.equal(scenario.unrelated.legacy, scenario.consumers * scenario.unrelatedUpdates);
  assert.equal(scenario.unrelated.scoped, 0);
  assert.equal(scenario.activeSubscriptionsAfterDispose, 0);
  assert(scenario.checks.length > 0);
  for (const check of scenario.checks) assert.equal(check.passed, true, check.id);
  assert.equal(report.decorationReadiness.preparedBeforeReveal, true);
  assert.equal(report.decorationReadiness.unfocusedVisiblePaneHasPresentation, true);
  assert.equal(report.decorationReadiness.unfocusedPaneOwnsCommands, false);
}
if (report.entityLinkOwnership) {
  assert.deepEqual(report.entityLinkOwnership.groups.map((group) => group.editors), [1, 5, 20]);
  for (const group of report.entityLinkOwnership.groups) assert.equal(group.correctEditors, group.editors);
  assert(report.entityLinkOwnership.checks.length > 0);
  for (const check of report.entityLinkOwnership.checks) assert.equal(check.passed, true, check.id);
}
if (report.agentEventProcessing) {
  const scenario = report.agentEventProcessing;
  assert(['record-copy', 'private-membership-index'].includes(scenario.implementation));
  assert.equal(scenario.repetitions, 3);
  assert.deepEqual(scenario.scenarios.map((item) => item.eventCount), [1_000, 3_000, 6_000]);
  for (const item of scenario.scenarios) {
    assert.match(item.fixtureHash, /^[0-9a-f]{64}$/);
    assert.equal(item.samplesMs.length, scenario.repetitions);
    assert(item.samplesMs.every((value) => Number.isFinite(value) && value >= 0));
    assert.equal(item.medianMs, [...item.samplesMs].sort((a, b) => a - b)[1]);
    assert.equal(item.notifications, item.eventCount);
    assert.equal(item.duplicateNotifications, 0);
    assert.equal(item.finalCharacters, item.eventCount);
    if (scenario.implementation === 'private-membership-index') assert(item.medianMs <= item.eventCount * 0.02, 'F4a ingestion budget exceeded');
  }
}
if (report.agentDisplay) {
  const scenario = report.agentDisplay;
  assert.equal(scenario.burst.immediate, scenario.consumers * scenario.streamEvents);
  assert.equal(scenario.burst.batched, 0);
  assert.equal(scenario.displayCommitsAfterFrame, scenario.consumers);
  assert(scenario.checks.length > 0);
  for (const check of scenario.checks) assert.equal(check.passed, true, check.id);
}
if (report.graphProjection) {
  const scenario = report.graphProjection;
  assert(['array-find', 'shared-id-index'].includes(scenario.implementation));
  assert.deepEqual(scenario.results.map((item) => item.elements), [100, 1_000, 5_000]);
  const baseline = read(path.join(directory, 'f5-graph-baseline.json')).graphProjection;
  for (const [index, item] of scenario.results.entries()) {
    assert.equal(item.fixtureHash, baseline.results[index].fixtureHash, 'F5a fixture changed');
    assert.equal(item.nodes, item.elements / 5);
    assert.equal(item.relations, item.elements * 3);
    assert.equal(item.projectedEdges, item.relations);
    for (const count of [item.firstProjectionIdReads, item.repeatedProjectionIdReads]) {
      assert(Number.isSafeInteger(count) && count >= 0);
    }
    assert.equal(item.samplesMs.length, 5);
    assert(item.samplesMs.every((value) => Number.isFinite(value) && value >= 0));
    assert.equal(item.medianMs, [...item.samplesMs].sort((a, b) => a - b)[2]);
    if (scenario.implementation === 'shared-id-index') {
      assert(item.firstProjectionIdReads <= item.elements + item.nodes, 'F5a index read budget exceeded');
      assert.equal(item.repeatedProjectionIdReads, 0);
      assert.equal(item.viewportProjectionIdReads, 0);
      assert.equal(item.worldProjectionMatchesFixture, true);
      assert(item.medianMs <= [10, 30, 100][index], 'F5a projection time budget exceeded');
    }
  }
}
if (report.graphGeometry) {
  const scenario = report.graphGeometry;
  assert(['per-edge-parent-state', 'unique-endpoint-overlay-state'].includes(scenario.implementation));
  assert.deepEqual(scenario.profiles.map((item) => [item.edges, item.uniqueEndpoints]), [[100, 20], [1_000, 100], [5_000, 500]]);
  const optimized = scenario.implementation === 'unique-endpoint-overlay-state';
  for (const item of scenario.profiles) {
    assert.equal(item.projectedEdges, item.edges);
    assert.equal(item.layoutReads, optimized ? item.uniqueEndpoints : item.edges * 2);
  }
  assert.equal(scenario.ownership.cards, 20);
  assert.equal(scenario.ownership.events, 100);
  if (optimized) {
    assert.equal(scenario.ownership.cardCommits, 0);
    assert.equal(scenario.ownership.geometryLabelReads, 0);
    assert.equal(scenario.ownership.geometryRenderPasses, 0);
    assert.equal(scenario.ownership.layoutReads, 100);
    assert.equal(scenario.moved.cardCommits, 0);
    assert.equal(scenario.moved.geometryRenderPasses, 1);
    assert.equal(scenario.moved.geometryLabelReads, 1_000);
    assert.equal(scenario.moved.layoutReads, 100);
    for (const id of ['entry-measurement-stops', 'burst-defers-layout-reads',
      'moved-geometry-only-renders-line-layer', 'pan-end-keeps-stale-lines-hidden',
      'pan-end-reveals-fresh-committed-lines', 'edge-hit-target-preserves-selection-anchor',
      'filtered-card-removes-only-dangling-lines', 'unmount-releases-listeners-and-observers',
      'unmount-cancels-pending-measurements']) {
      assert(scenario.checks.some((check) => check.id === id && check.passed), `missing F5b check ${id}`);
    }
    for (const check of scenario.checks) assert.equal(check.passed, true, check.id);
  } else {
    assert.equal(scenario.ownership.cardCommits, 2_000);
    assert.equal(scenario.ownership.geometryCommits, 100);
    assert.equal(scenario.ownership.layoutReads, 200_000);
  }
}
if (report.graphOverlays) {
  const { viewport, story } = report.graphOverlays;
  assert.deepEqual(viewport.unchanged, { cardCommits: 0, lineRenders: 0 });
  assert.deepEqual(viewport.resized, { cardCommits: 0, lineRenders: 1 });
  assert.deepEqual(story.unchanged, { cardCommits: 0, lineRenders: 0, layoutReads: 100 });
  assert.deepEqual(story.moved, { cardCommits: 0, lineRenders: 1, layoutReads: 100 });
  for (const [scenario, required] of [[viewport, ['sticky-node-matches-real-band-dom',
    'container-resize-keeps-band-and-svg-aligned', 'viewport-pan-end-keeps-old-lines-hidden',
    'viewport-pan-end-reveals-aligned-lines', 'label-only-change-reaches-tooltip', 'viewport-unmount-removes-layer']],
  [story, ['story-animation-window-stops', 'story-svg-preserves-edge-count-style-and-arrows',
    'story-layer-is-visible-after-measurement', 'story-scroll-burst-one-read-per-endpoint-no-render',
    'story-hit-target-preserves-anchor', 'story-bound-filter-removes-dangling-lines', 'story-unmount-cancels-reads']]]) {
    for (const id of required) assert(scenario.checks.some((check) => check.id === id && check.passed), `missing F5c check ${id}`);
    for (const check of scenario.checks) assert.equal(check.passed, true, check.id);
  }
}
if (report.timeline) {
  const { leaders, marker, act } = report.timeline;
  assert(['array-find', 'shared-id-index'].includes(leaders.implementation));
  assert.deepEqual(leaders.profiles.map((item) => item.chapters), [100, 1_000, 5_000]);
  for (const [index, item] of leaders.profiles.entries()) {
    assert.equal(item.leaders, item.chapters);
    assert.equal(item.samplesMs.length, 5);
    assert(item.samplesMs.every((value) => Number.isFinite(value) && value >= 0));
    assert.equal(item.medianMs, [...item.samplesMs].sort((a, b) => a - b)[2]);
    if (leaders.implementation === 'shared-id-index') {
      assert(item.firstIdReads <= item.chapters, 'F5d leader index read budget exceeded');
      assert.equal(item.repeatedIdReads, 0);
      assert.equal(item.pathsMatchFixture, true);
      assert(item.medianMs <= [10, 30, 50][index], 'F5d leader projection budget exceeded');
    } else {
      assert.equal(item.firstIdReads, item.chapters * (item.chapters + 1) / 2);
      assert.equal(item.repeatedIdReads, item.firstIdReads);
    }
  }
  assert(['parent-preview-state', 'local-pin-and-guide-preview'].includes(marker.implementation));
  if (marker.implementation === 'parent-preview-state') {
    assert.equal(marker.dragCardCommits, 2_000);
    assert.deepEqual(marker.writes, [11.4]);
  } else {
    assert.deepEqual(marker.groups.map((group) => group.variant), ['bottom', 'graph']);
    for (const group of marker.groups) {
      assert.equal(group.cards, 20); assert.equal(group.moves, 100);
      assert.equal(group.dragCardCommits, 0); assert.equal(group.frameNotifications, 1);
      assert.deepEqual(group.writes, [11.4, 11.575]);
      for (const id of ['pointer-burst-does-not-render-cards', 'one-frame-publishes-latest-guide',
        'pin-line-hides-during-drag', 'display-frame-does-not-render-cards',
        'pointer-up-commits-continuous-coordinate', 'pointer-up-clears-preview-immediately',
        'pointer-up-before-frame-keeps-exact-final-coordinate', 'ended-preview-does-not-reappear',
        'foreign-pointer-cannot-cancel-active-drag', 'cancel-clears-without-write',
        'window-blur-cancels-without-write', 'pin-unmount-cancels-pending-drag-and-listeners']) {
        assert(group.checks.some((check) => check.id === id && check.passed), `missing F5d marker check ${id}`);
      }
      for (const check of group.checks) assert.equal(check.passed, true, check.id);
    }
    assert.equal(act.cards, 20); assert.equal(act.moves, 100); assert.equal(act.dragCardCommits, 0);
    assert.equal(act.frameNotifications, 1); assert.deepEqual(act.writes, [11.4, 11.575]);
    for (const id of ['act-pointer-burst-does-not-render-cards', 'act-guide-coalesces-and-keeps-host-offset',
      'act-commits-continuous-coordinate', 'act-commit-does-not-wait-for-frame',
      'act-cancel-clears-without-write', 'act-unmount-cancels-without-write']) {
      assert(act.checks.some((check) => check.id === id && check.passed), `missing F5d act check ${id}`);
    }
    for (const check of act.checks) assert.equal(check.passed, true, check.id);
  }
}
const scenarioIds = new Set();
for (const scenario of report.scenarios) {
  assert(!scenarioIds.has(scenario.id));
  scenarioIds.add(scenario.id);
  assert.match(scenario.fixture.hash, /^[0-9a-f]{64}$/);
  assert.equal(scenario.finalLinks, scenario.fixture.links);
  assert.equal(scenario.finalCharacters, scenario.fixture.characters + scenario.warmupOperations + scenario.countedOperations + scenario.timingOperations);
  for (const count of Object.values(scenario.counts)) assert(Number.isSafeInteger(count) && count >= 0);
  for (const metric of [scenario.transactionMs, scenario.transactionToAnimationFrameMs]) {
    assert.equal(metric.samples.length, scenario.timingOperations);
    assert(metric.samples.every((value) => Number.isFinite(value) && value >= 0));
    const sorted = [...metric.samples].sort((a, b) => a - b);
    assert.equal(metric.median, sorted[Math.floor(sorted.length / 2)]);
    assert.equal(metric.p95, sorted[Math.ceil(sorted.length * 0.95) - 1]);
  }
}
console.log(`Renderer performance contract passed: ${phases.size} phases, ${criteria.size} criteria, ${report.scenarios.length} measured scenarios. No native acceptance inferred.`);
