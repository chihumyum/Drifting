import { describe, expect, it } from 'vitest';

import type { SyncEngineDiagnostics, SyncGenerationRuntimeStatus } from './engine';
import {
  SYNC_FAILING_FOR_MS,
  SYNC_MARK_LINGER_MS,
  SYNC_MARK_SHOW_AFTER_MS,
  SYNC_RETRY_SHOW_AFTER_MS,
  SyncHealthTracker,
  syncCornerFor,
  syncProblemsOf,
  type SyncHealthInput,
} from './sync-health';

const BOOK = 'project-a';

function generation(overrides: Partial<SyncGenerationRuntimeStatus> = {}): SyncGenerationRuntimeStatus {
  return {
    syncGenerationId: 'sync-a',
    projectId: BOOK,
    phase: 'idle',
    cycleNumber: 1,
    lastPullSuccessAtMs: null,
    lastPublishSuccessAtMs: null,
    lastConvergedAtMs: null,
    lastOutcome: 'success',
    lastFailedPhase: null,
    lastErrorCode: null,
    transferProgress: null,
    pending: {
      pendingChangeSets: 0,
      pendingSegments: 0,
      pendingTransfers: 0,
      openGaps: 0,
      openConflicts: 0,
      quarantinedObjects: 0,
    },
    ...overrides,
  };
}

function input(generations: SyncGenerationRuntimeStatus[], overrides: Partial<SyncHealthInput> = {}): SyncHealthInput {
  const diagnostics: SyncEngineDiagnostics = {
    generatedAtMs: 0,
    activeSyncGenerationId: null,
    online: true,
    suspended: false,
    generations,
  };
  return { loaded: true, hosted: true, paused: false, session: 'connected', activationFailed: false, diagnostics, ...overrides };
}

function corner(tracker: SyncHealthTracker, nowMs: number) {
  return syncCornerFor(tracker.evaluate(nowMs).health, BOOK);
}

const uploading = (cycleNumber: number, completedObjects = 3) =>
  generation({
    phase: 'publishing-segments',
    cycleNumber,
    transferProgress: {
      stage: 'upload-changes',
      completedObjects,
      totalObjects: 561,
      transferredBytes: 1000,
      totalBytes: 9000,
      totalKnown: true,
    },
  });

describe('sync health', () => {
  it('knows nothing before the sync authority has been read', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([], { loaded: false, activationFailed: true }), 0);
    expect(tracker.evaluate(0).health).toMatchObject({ observed: false, globalProblem: null });
    tracker.observe(input([], { hosted: false }), 0);
    expect(tracker.evaluate(0).health).toMatchObject({ observed: true, hosted: false });
  });

  it('shows nothing for a synced book, a local library or a paused one', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([generation()]), 0);
    expect(corner(tracker, 0)).toEqual({ kind: 'none' });

    tracker.observe(input([uploading(2)], { hosted: false }), 0);
    expect(corner(tracker, 10_000)).toEqual({ kind: 'none' });

    const paused = new SyncHealthTracker();
    paused.observe(input([uploading(2)], { paused: true }), 0);
    expect(corner(paused, 10_000)).toEqual({ kind: 'none' });
  });

  it('shows the cloud only once a run of cycles has been busy for three seconds', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([uploading(2)]), 0);
    const early = tracker.evaluate(SYNC_MARK_SHOW_AFTER_MS - 1);
    expect(syncCornerFor(early.health, BOOK).kind).toBe('none');
    expect(early.wakeAtMs).toBe(SYNC_MARK_SHOW_AFTER_MS);

    const shown = corner(tracker, SYNC_MARK_SHOW_AFTER_MS);
    expect(shown).toMatchObject({ kind: 'syncing', transfer: { progress: { stage: 'upload-changes', totalObjects: 561 } } });
  });

  it('never shows a short cycle', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([uploading(2)]), 0);
    tracker.observe(input([generation({ cycleNumber: 2 })]), 800);
    expect(corner(tracker, 5_000).kind).toBe('none');
  });

  it('keeps the cloud through a short gap between rounds and lets it go after the linger', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([uploading(2)]), 0);
    tracker.observe(input([generation({ cycleNumber: 2 })]), 4_000);
    expect(corner(tracker, 4_500).kind).toBe('syncing');

    tracker.observe(input([uploading(3, 40)]), 4_600);
    tracker.observe(input([generation({ cycleNumber: 3 })]), 9_000);
    const lingering = tracker.evaluate(9_000);
    expect(syncCornerFor(lingering.health, BOOK)).toMatchObject({ kind: 'syncing', transfer: { progress: { completedObjects: 40 } } });
    expect(lingering.wakeAtMs).toBe(9_000 + SYNC_MARK_LINGER_MS);
    expect(corner(tracker, 9_000 + SYNC_MARK_LINGER_MS).kind).toBe('none');
  });

  it('turns repeated failures into retrying, then a problem the bell carries', () => {
    const tracker = new SyncHealthTracker();
    const failed = (cycleNumber: number) =>
      generation({ cycleNumber, lastOutcome: 'failed', lastErrorCode: 'SYNC_CYCLE_FAILED' });

    tracker.observe(input([failed(2)]), 0);
    expect(corner(tracker, SYNC_RETRY_SHOW_AFTER_MS - 1).kind).toBe('none');
    expect(corner(tracker, SYNC_RETRY_SHOW_AFTER_MS)).toEqual({ kind: 'retrying', syncGenerationIds: ['sync-a'] });

    tracker.observe(input([failed(3)]), 40_000);
    tracker.observe(input([failed(4)]), 50_000);
    expect(corner(tracker, 50_000)).toMatchObject({ kind: 'problem', problem: 'failing', errorCode: 'SYNC_CYCLE_FAILED', failures: 3 });
    expect(syncProblemsOf(tracker.evaluate(50_000).health)).toEqual([
      { problem: 'failing', projectId: BOOK, syncGenerationIds: ['sync-a'], errorCode: 'SYNC_CYCLE_FAILED', failures: 3 },
    ]);

    tracker.observe(input([generation({ cycleNumber: 5 })]), 60_000);
    expect(corner(tracker, 60_000).kind).toBe('none');
    expect(syncProblemsOf(tracker.evaluate(60_000).health)).toEqual([]);
  });

  it('counts a failure that lasts five minutes as a problem even with few cycles', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([generation({ cycleNumber: 2, lastOutcome: 'failed' })]), 0);
    expect(tracker.evaluate(0).wakeAtMs).toBe(SYNC_RETRY_SHOW_AFTER_MS);
    expect(corner(tracker, SYNC_FAILING_FOR_MS)).toMatchObject({ kind: 'problem', problem: 'failing' });
  });

  it('makes a full quota a problem at once', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([generation({ cycleNumber: 2, lastOutcome: 'failed', lastErrorCode: 'QUOTA_EXCEEDED' })]), 0);
    expect(corner(tracker, 0)).toMatchObject({ kind: 'problem', problem: 'quota', errorCode: 'QUOTA_EXCEEDED' });
  });

  it('puts a sync that could not start and an expired session on every book', () => {
    const notStarted = new SyncHealthTracker();
    notStarted.observe(input([], { activationFailed: true, diagnostics: null }), 0);
    expect(corner(notStarted, 0)).toMatchObject({ kind: 'problem', problem: 'not-started' });
    expect(syncProblemsOf(notStarted.evaluate(0).health)).toMatchObject([{ problem: 'not-started', projectId: null }]);

    const expired = new SyncHealthTracker();
    expired.observe(input([uploading(2)], { session: 'needs-reauth', paused: true }), 0);
    expect(corner(expired, 0)).toMatchObject({ kind: 'problem', problem: 'reauth' });
  });

  it('shows offline over retrying and syncing, with what is still to send', () => {
    const tracker = new SyncHealthTracker();
    const pending = generation({ pending: { ...generation().pending, pendingChangeSets: 561 } });
    tracker.observe(input([pending], { session: 'offline' }), 0);
    expect(corner(tracker, 0)).toEqual({ kind: 'offline', pendingChanges: 561 });

    const engineOffline = new SyncHealthTracker();
    const offlineInput = input([pending]);
    engineOffline.observe({ ...offlineInput, diagnostics: { ...offlineInput.diagnostics!, online: false } }, 0);
    expect(corner(engineOffline, 0).kind).toBe('offline');
  });

  it('only shows the open book on the paper', () => {
    const tracker = new SyncHealthTracker();
    tracker.observe(input([generation({ projectId: 'project-b', cycleNumber: 2, lastOutcome: 'failed', lastErrorCode: 'QUOTA_EXCEEDED' })]), 0);
    expect(corner(tracker, 0).kind).toBe('none');
    expect(syncProblemsOf(tracker.evaluate(0).health)).toMatchObject([{ problem: 'quota', projectId: 'project-b' }]);
  });
});
