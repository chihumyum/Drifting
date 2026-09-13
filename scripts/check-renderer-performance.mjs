import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { rendererFingerprintVersion, rendererSourceFingerprint } from './renderer-performance-source.mjs';

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
const deterministic = process.argv.includes('--deterministic');
assert.equal(report.schemaVersion, 1);
assert.equal(report.kind, 'renderer_performance_run');
assert.equal(report.status, 'measured');
assert.match(report.source.commit, /^[0-9a-f]{40}$/);
assert.match(report.source.rendererFingerprint, /^[0-9a-f]{64}$/);
assert(report.limitations.length > 0);
assert(report.scenarios.length > 0);
if (process.argv.includes('--current')) {
  assert.equal(report.source.fingerprintVersion, rendererFingerprintVersion, 'current source fingerprint version required');
  assert.equal(report.source.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), 'report is from another commit');
  assert.equal(report.source.rendererFingerprint, rendererSourceFingerprint(root), 'report is from another source tree');
}
if (deterministic) {
  // Historical reports may legitimately predate a scenario. Ordinary CI must
  // execute every current contract and may not pass by omitting its section.
  for (const key of ['behaviorChecks', 'reactSubscriptions', 'semanticSubscriptions',
    'agentDecorations', 'decorationReadiness', 'entityLinkOwnership', 'agentEventProcessing',
    'agentDisplay', 'agentPanel', 'agentHistory', 'agentTranscript', 'agentBackground', 'agentRecovery', 'agentJournal', 'mobileAgentPanel', 'graphProjection', 'superElementCards', 'storyGraphCards', 'graphGeometry', 'graphOverlays', 'timeline',
    'workspaceProjection', 'editorContextMenus', 'editorSuggestions', 'inlineCopilot', 'inlineEditApply', 'copilotRuns']) {
    assert(report[key] && (!Array.isArray(report[key]) || report[key].length > 0), `missing current contract ${key}`);
  }
  assert.deepEqual(report.scenarios.map(item => [item.fixture.characters, item.fixture.links]), [[5_000, 0], [20_000, 100], [50_000, 500]]);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.countedOperations, 100);
    assert.deepEqual(scenario.counts, { fullLinkQueries: 0, colorResolutions: 0, styleWrites: 0 }, 'input locality regressed');
  }
  assert.deepEqual(report.reactSubscriptions.map(item => item.consumers), [1, 5, 20]);
  for (const item of report.reactSubscriptions) assert.equal(item.operations, 100);
  assert.equal(report.agentEventProcessing.implementation, 'private-membership-index');
  assert.equal(report.graphProjection.implementation, 'shared-id-index');
  assert.equal(report.graphGeometry.implementation, 'unique-endpoint-overlay-state');
  assert.equal(report.timeline.leaders.implementation, 'shared-id-index');
  assert.equal(report.timeline.marker.implementation, 'local-pin-and-guide-preview');
  assert.equal(report.workspaceProjection.membership.implementation, 'linear-membership-sets');
  assert.equal(report.workspaceProjection.publication.implementation, 'share-capture-values');
}
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
if (report.inlineCopilot) {
  assert.equal(report.inlineCopilot.cycles, 100);
  assert(report.inlineCopilot.checks.length >= 25);
  assert.deepEqual(report.inlineCopilot.services, { edits: report.inlineCopilot.conflictFeedback ? 3 : 2, asks: 2, summaries: 2 });
  assert.equal(report.inlineCopilot.listeners.peak, 1);
  assert.equal(report.inlineCopilot.listeners.remaining, 0);
  assert.equal(report.inlineCopilot.listeners.additions, report.inlineCopilot.listeners.removals);
}
if (report.copilotRuns) {
  assert.equal(report.copilotRuns.checks.length, 21);
  assert.equal(report.copilotRuns.cycles, 100);
  assert.equal(report.copilotRuns.detections, 11);
  assert.equal(report.copilotRuns.writes, 2);
  assert.equal(report.copilotRuns.summaries, 3);
  assert.equal(report.copilotRuns.remainingManualListeners, 0);
}
if (report.inlineEditApply) {
  assert.equal(report.inlineCopilot.conflictFeedback, true);
  assert.equal(report.inlineEditApply.checks.length, 26);
  assert.equal(report.inlineCopilot.spanTrackers.peak, 1);
  assert.equal(report.inlineCopilot.spanTrackers.remaining, 0);
  assert.equal(report.inlineCopilot.spanTrackers.additions, report.inlineCopilot.spanTrackers.removals);
  assert.deepEqual(report.inlineEditApply.collaborativeHistory, { separateUndoItems: 3, exactOriginalRestored: true, mappedCollaborativeSpan: true, sameTextPeerReplacementRejected: true, yjsObservers: { additions: 2, removals: 2, remaining: 0 } });
}
if (report.editorSuggestions) {
  assert.equal(report.environment.documentFocused, true);
  assert.deepEqual(report.editorSuggestions.groups.map(group => group.editors), [1, 5, 20]);
  for (const group of report.editorSuggestions.groups) {
    assert.equal(group.cyclesPerMenu, 100);
    assert.equal(group.maxSubscriptions, group.editors * 2);
    assert.equal(group.subscriptions, group.releases);
    assert.equal(group.remainingSubscriptions, 0);
    assert(group.checks.length >= 16);
  }
  assert.equal(report.editorSuggestions.asyncCreation.length, 13);
  assert(report.editorSuggestions.asyncCreation.every(item => item.passed && item.creations === 1));
  assert.equal(report.editorSuggestions.template.blurClosesAndRejectsStaleActions, true);
}
if (report.editorContextMenus) {
  assert.equal(report.editorContextMenus.collaborativeFormats.checks.length, 7);
  assert.equal(report.editorContextMenus.initialSessionFocus.checks.length, 2);
  assert.deepEqual(report.editorContextMenus.groups.map(group => group.editors), [1, 5, 20]);
  for (const group of report.editorContextMenus.groups) {
    assert.equal(group.actionCycles, 100); assert.equal(group.comments, 100);
    assert.equal(group.maxDocumentListeners, 2);
    assert.equal(group.additions, group.removals);
    assert.equal(group.remainingDocumentListeners, 0); assert.equal(group.remainingHideTimers, 0);
    assert(group.checks.length >= 12);
  }
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
    if (!deterministic && scenario.implementation === 'private-membership-index') assert(item.medianMs <= item.eventCount * 0.02, 'F4a ingestion budget exceeded');
  }
}
if (report.agentTranscript) {
  const reportPart = report.agentTranscript;
  assert.deepEqual(reportPart.projections.map(item => [item.implementation, item.historyMessages]), [300, 3000, 30000].flatMap(size => [['array-reference', size], ['persistent-tree', size]]));
  function treeWork(work, eventCount) {
    assert.equal(work.copiedArraySlots, 0); assert.equal(work.flatMaterializations, 0); assert.equal(work.flattenedMessages, 0);
    assert(work.copiedTreeNodes >= eventCount && work.copiedTreeNodes <= eventCount * 3, 'unbounded event tree copies');
    assert(work.copiedTreeSlots <= eventCount * 96, 'history copied during ingress');
  }
  for (const item of reportPart.projections) {
    assert.match(item.fixtureHash, /^[0-9a-f]{64}$/); assert.equal(item.eventCount, 6000);
    assert.equal(item.samplesMs.length, 3); assert(item.samplesMs.every(value => Number.isFinite(value) && value >= 0));
    assert.equal(item.medianMs, [...item.samplesMs].sort((a, b) => a - b)[1]); assert.equal(item.work.length, 3);
    for (const work of item.work) {
      if (item.implementation === 'persistent-tree') treeWork(work, item.eventCount);
      else assert.deepEqual(work, { copiedTreeNodes: 0, copiedTreeSlots: 0, copiedArraySlots: (item.historyMessages + 1) * item.eventCount, flatMaterializations: 0, flattenedMessages: 0 });
    }
  }
  assert.deepEqual(reportPart.ingress.map(item => item.historyMessages), [300, 3000, 30000]);
  for (const item of reportPart.ingress) {
    assert.equal(item.eventCount, 6000); assert(Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0);
    assert.equal(item.fixtureHash, reportPart.projections.find(p => p.historyMessages === item.historyMessages).fixtureHash);
    treeWork(item.eventWork, item.eventCount);
    assert.deepEqual(item.duplicateWork, { copiedTreeNodes: 0, copiedTreeSlots: 0, copiedArraySlots: 0, flatMaterializations: 0, flattenedMessages: 0 });
    assert.equal(item.beforeFrame, 0); assert.equal(item.afterFrame, 1);
    assert.deepEqual(item.frameWork, { flatMaterializations: 1, flattenedMessages: item.historyMessages + 1 });
    assert.deepEqual(item.checks, { canonicalCurrentBeforeFrame: true, originalSnapshotUnchanged: true, completeDisplay: true, duplicatesPreserveSnapshot: true });
  }
}
if (report.agentBackground) {
  const baseline = read(path.join(directory, 'f4-background-baseline.json')).agentBackground;
  assert.deepEqual(report.agentBackground.measurements.map(item => item.historyMessages), [300, 3000, 30000]);
  for (const [index, item] of report.agentBackground.measurements.entries()) {
    assert.equal(item.fixtureHash, baseline.measurements[index].fixtureHash); assert.equal(item.eventCount, 6000);
    assert(Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0);
    assert.equal(item.ingressWork.copiedArraySlots, 0); assert.equal(item.ingressWork.flatMaterializations, 0);
    assert.equal(item.ingressWork.flattenedMessages, 0);
    assert(item.ingressWork.copiedTreeNodes >= item.eventCount && item.ingressWork.copiedTreeNodes <= item.eventCount * 3);
    assert(item.ingressWork.copiedTreeSlots <= item.eventCount * 96);
    assert.deepEqual(item.duplicateWork, { copiedTreeNodes: 0, copiedTreeSlots: 0, copiedArraySlots: 0, flatMaterializations: 0, flattenedMessages: 0 });
    assert.deepEqual(item.scheduled, { frames: 0, timers: 1, timerDelays: [50] });
    assert.equal(item.beforeTimer, 0); assert.equal(item.afterTimer, 1);
    assert.deepEqual(item.timerWork, { flatMaterializations: 1, flattenedMessages: item.historyMessages + 1 });
    assert.deepEqual(item.checks, { canonicalCurrentBeforeTimer: true, completeDisplay: true, duplicatesPreserveSnapshot: true,
      originalSnapshotUnchanged: true, foregroundFlushesTail: true, disposedResources: true });
  }
}
if (report.storyGraphCards) {
  const baseline = read(path.join(directory, 'f5-story-cards-baseline.json')).storyGraphCards;
  assert.deepEqual(report.storyGraphCards.measurements.map(item => [item.chapters, item.storylines]), [[100, 8], [1000, 24], [5000, 50]]);
  for (const [index, item] of report.storyGraphCards.measurements.entries()) {
    assert.equal(item.fixtureHash, baseline.measurements[index].fixtureHash);
    assert.equal(item.lanes, item.storylines + 1); assert.equal(item.drawerToggles, 20); assert.equal(item.popoverCycles, 10); assert.equal(item.pointerMoves, 100);
    assert.deepEqual(item.mountWork, { lanes: item.lanes, tiles: item.chapters, groupingVisits: item.chapters }, 'Story Graph initial grouping must visit each chapter once and instrument each card.');
    for (const work of [item.drawerWork, item.popoverWork, item.pointerWork]) {
      assert.deepEqual(work, { lanes: 0, tiles: 0, groupingVisits: 0 }, 'Story Graph transient state rebuilt unchanged lanes or regrouped chapters.');
    }
    assert.deepEqual(item.checks, { allCardsRetained: true, primaryLaneMembership: true, drawerReturned: true, popoverCycles: true,
      cancelledDragCleaned: true, shiftSelectsSource: true, shiftClearsSource: true, latestPair: true, renamedCard: true,
      reassignedPrimaryLane: true, contextMenuUsesCurrentNode: true, doubleClickNavigation: true });
  }
}
if (report.superElementCards) {
  const baseline = read(path.join(directory, 'f5-cards-baseline.json')).superElementCards;
  assert.deepEqual(report.superElementCards.measurements.map(item => item.elements), [100, 1000, 5000]);
  for (const [index, item] of report.superElementCards.measurements.entries()) {
    assert.equal(item.fixtureHash, baseline.measurements[index].fixtureHash);
    assert.equal(item.categories, 8); assert.equal(item.chapters, 20); assert.equal(item.focusToggles, 20); assert.equal(item.wheelEvents, 100);
    assert(Number.isFinite(item.focusMs) && item.focusMs >= 0);
    assert.deepEqual(item.focusWork, { categories: 0, elements: 0, bands: 0 }, 'Focus mode rerendered the stable card tree.');
    assert.deepEqual(item.wheelWork, { categories: 0, elements: 0, bands: 0 }, 'Wheel commit rerendered the stable card tree.');
    assert.deepEqual(item.checks, { allCardsRetained: true, focusModeReturned: true, shiftSelectsSource: true, shiftClearsSource: true,
      elementPairUsesLatestSource: true, chapterPairUsesLatestSource: true, renameUpdatesCard: true, categoryNavigation: true });
  }
}
if (report.agentJournal) {
  assert.equal(report.agentJournal.cycles, 100);
  assert.deepEqual(report.agentJournal.checks.map(check => check.id), [
    'one-connection-and-no-late-work-after-100-disposals',
    'foreign-project-kind-and-conflicting-route-rejected',
    'registered-turn-routes-without-visible-conversation',
    'duplicate-keeps-state-and-effects',
    'released-mapping-allows-explicit-sibling-route',
    'background-project-does-not-pulse-visible-activity',
    'accepted-terminal-finishes-effects-during-disposal',
    'terminal-persistence-sees-final-array',
    'unavailable-connection-is-retryable',
    'failed-connection-callback-cannot-enter-new-generation',
    'retried-connection-receives-new-events',
    'second-subscription-failure-releases-journal',
    'second-subscription-failure-can-retry',
    'disposal-during-journal-connection-cleans-returned-listener',
    'disposal-during-changes-connection-cleans-both-listeners',
  ]);
  assert(report.agentJournal.checks.every(check => check.passed === true), 'journal owner lifecycle regressed');
}
if (report.agentRecovery) {
  assert.deepEqual(report.agentRecovery.measurements.map(item => item.turns), [100, 500, 1500]);
  for (const item of report.agentRecovery.measurements) {
    assert.match(item.fixtureHash, /^[0-9a-f]{64}$/);
    assert.equal(item.events, item.turns * 27); assert.equal(item.messages, item.turns * 4 + item.turns / 50 * 2);
    assert.equal(item.samplesMs.length, 3); assert(item.samplesMs.every(value => Number.isFinite(value) && value >= 0));
    assert.equal(item.medianMs, [...item.samplesMs].sort((a, b) => a - b)[1]); assert.equal(item.work.length, 3);
    for (const work of item.work) {
      assert.equal(work.copiedArraySlots, 0, 'recovery copied the historical message array');
      assert.equal(work.flatMaterializations, 1); assert.equal(work.flattenedMessages, item.messages);
      assert(work.copiedTreeNodes > 0 && work.copiedTreeNodes <= item.events * 3);
      assert(work.copiedTreeSlots > 0 && work.copiedTreeSlots <= item.events * 96);
      assert.equal(work.groupedMessageVisits, item.turns * 2, 'recovery rescanned message groups');
      assert.equal(work.promptMessageVisits, item.turns, 'recovery rescanned prompt messages');
      assert.equal(work.recoveredTurnVisits, item.turns, 'display rescanned recovered turns');
      assert.equal(work.visibleUserCandidates, item.turns + item.turns / 50, 'display rescanned consumed visible users');
    }
    assert.deepEqual(item.checks, { independentDisplay: true, representedEvents: true, terminalAndContext: true, immutableInput: true, singleSnapshotRead: true });
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
if (report.agentHistory && (deterministic || report.agentHistory.implementation)) {
  const history = report.agentHistory;
  assert.equal(history.implementation, 'stable-message-blocks');
  assert.equal(history.measure, true);
  assert.deepEqual(history.measurements.map(item => [item.surface, item.historyMessages]), [['desktop', 300], ['desktop', 3000], ['mobile', 300], ['mobile', 3000]]);
  for (const item of history.measurements) {
    assert.match(item.fixtureHash, /^[0-9a-f]{64}$/);
    assert.equal(item.displayUpdates, 20);
    assert.equal(item.rowElements, ((item.historyMessages % 64) + 1) * 20, 'history row creation regressed');
    assert.equal(item.updateMs.length, 20);
    assert(item.updateMs.every(value => Number.isFinite(value) && value >= 0));
    const sorted = [...item.updateMs].sort((a, b) => a - b);
    assert.equal(item.medianMs, sorted[10]); assert.equal(item.p95Ms, sorted[18]);
    assert.deepEqual(item.checks.map(check => check.id), ['all-history-stays-mounted', 'historical-dom-and-selection-retained', 'tool-detail-dom-and-expansion-retained', 'latest-text-complete']);
    assert(item.checks.every(check => check.passed === true));
  }
}
if (report.agentPanel) {
  const scenario = report.agentPanel;
  // The baseline records the original full-panel renders and missing initial
  // bottom position. Current CI requires the isolated transcript contract.
  if (deterministic || scenario.drafting) {
    assert.equal(scenario.checks.length, 24);
    assert.equal(scenario.historyMessages, 300);
    assert.equal(scenario.displayBatches, 20);
    assert.equal(scenario.streamEvents, 400);
    assert.deepEqual(scenario.streaming, { panel: 0, composer: 0, message: 20, transcript: 20 });
    assert.deepEqual(scenario.drafting, { panel: 20, composer: 20, message: 0, transcript: 0 });
    assert.equal(scenario.initialBottom, true);
    assert.equal(scenario.returningBottom, true);
    assert.equal(scenario.cycles, 100);
    assert.equal(scenario.remainingAuthListeners, 0);
  }
}
if (report.mobileAgentPanel && (deterministic || report.mobileAgentPanel.verifyRenders)) {
  const panel = report.mobileAgentPanel;
  assert.equal(panel.verifyRenders, true);
  assert.equal(panel.checks.length, 52);
  assert.equal(panel.historyMessages, 300); assert.equal(panel.displayBatches, 20); assert.equal(panel.streamEventsPerMode, 400);
  assert.deepEqual(panel.measurements.map(item => item.mode), ['sidebar', 'paper']);
  for (const item of panel.measurements) {
    assert.deepEqual(item.streaming, { panel: 0, composer: 0, message: 20, transcript: 20 });
    assert.deepEqual(item.drafting, { panel: 20, composer: 20, message: 0, transcript: 0 });
    assert.deepEqual(item.background, { panel: 0, composer: 0, message: 0, transcript: 0 });
    assert.equal(item.messageRows, 20); assert.equal(item.cycles, 100);
    assert.equal(item.lateFeedbackCrossedSession, false); assert.equal(item.lateNavigation, 0); assert.equal(item.duplicateWrites, 1);
  }
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
      if (!deterministic) assert(item.medianMs <= [10, 30, 100][index], 'F5a projection time budget exceeded');
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
      if (!deterministic) assert(item.medianMs <= [10, 30, 50][index], 'F5d leader projection budget exceeded');
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
if (report.workspaceProjection) {
  const { membership, publication, subscriptions } = report.workspaceProjection;
  const baseline = read(path.join(directory, 'f6-workspace-baseline.json')).workspaceProjection;
  assert(['copy-and-includes', 'linear-membership-sets'].includes(membership.implementation));
  assert(['replace-capture', 'share-capture-values'].includes(publication.implementation));
  const optimized = publication.implementation === 'share-capture-values';
  for (const [scenario, reference] of [[membership, baseline.membership], [publication, baseline.publication]]) {
    assert.deepEqual(scenario.profiles.map((item) => item.nodes), [100, 1_000, 5_000]);
    for (const [index, item] of scenario.profiles.entries()) {
      assert.equal(item.fixtureHash, reference.profiles[index].fixtureHash, 'F6a1 fixture changed');
      assert.equal(item.samplesMs.length, 5);
      assert(item.samplesMs.every((value) => Number.isFinite(value) && value >= 0));
      assert.equal(item.medianMs, [...item.samplesMs].sort((a, b) => a - b)[2]);
    }
  }
  for (const [index, item] of membership.profiles.entries()) {
    assert.equal(item.links, item.nodes * 2); assert.equal(item.matchesFixture, true);
    assert.equal(item.scannedSlots, membership.implementation === 'linear-membership-sets' ? 0 : item.nodes * (item.nodes - 1));
    if (!deterministic && membership.implementation === 'linear-membership-sets') assert(item.medianMs <= [5, 10, 30][index], 'F6a1 membership budget exceeded');
  }
  for (const [index, item] of publication.profiles.entries()) {
    assert.equal(item.elements, item.nodes / 5); assert.equal(item.slices, 17);
    assert.equal(item.reusedNodeRecords, optimized ? item.nodes : 0);
    assert.equal(item.stableCollections, optimized ? 16 : 0);
    if (!deterministic && optimized) assert(item.medianMs <= [10, 30, 50][index], 'F6a1 publication comparison budget exceeded');
  }
  assert.equal(subscriptions.consumers, 20); assert.equal(subscriptions.refreshes, 100);
  assert.deepEqual(subscriptions.unrelated, { fields: optimized ? 0 : 2_000, records: optimized ? 0 : 2_000 });
  assert.deepEqual(subscriptions.rename, { fields: 20, records: optimized ? 1 : 20 });
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
console.log(`Renderer ${deterministic ? 'deterministic CI' : 'performance'} contract passed: ${phases.size} phases, ${criteria.size} criteria, ${report.scenarios.length} measured scenarios. No native acceptance inferred.`);
