import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flushLocal: vi.fn(),
  reportIntegrityEvent: vi.fn(),
}));
vi.mock('../lib/persistence-lifecycle', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/persistence-lifecycle')>(),
  flushLocalApplicationPersistence: mocks.flushLocal,
}));
vi.mock('../services/diagnostics/crash-reporter', () => ({
  reportDiagnosticLog: vi.fn(),
  reportIntegrityEvent: mocks.reportIntegrityEvent,
}));

import { SyncEngineCoordinator } from './engine';
import {
  flushLocalDurabilityForSync,
  reportSyncCycleFailure,
  SyncLocalFlushError,
} from './production-runtime';

beforeEach(() => {
  mocks.flushLocal.mockReset().mockResolvedValue(undefined);
  mocks.reportIntegrityEvent.mockReset();
});

it('marks a local write failure met by a sync cycle as retryable', async () => {
  const failure = new AggregateError(
    [new Error('synthetic asset write failed')],
    '1 local persistence step(s) failed: assets',
  );
  mocks.flushLocal.mockRejectedValueOnce(failure);

  const error = await flushLocalDurabilityForSync().catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(SyncLocalFlushError);
  expect(error).toMatchObject({ code: 'LOCAL_FLUSH_FAILED', retryable: true, cause: failure });
  await expect(flushLocalDurabilityForSync()).resolves.toBeUndefined();
});

it('reports a local write failure as such, not as a sync stop', () => {
  const failure = new AggregateError([], '1 local persistence step(s) failed: session-token');

  reportSyncCycleFailure(new SyncLocalFlushError(failure));

  expect(mocks.reportIntegrityEvent).toHaveBeenCalledExactlyOnceWith(
    'local-flush-failed',
    failure,
    { reason: 'sync-cycle' },
  );
});

it('still reports a cycle that cannot be retried as blocked, and ignores expected stops', () => {
  const corrupt = Object.assign(new Error('synthetic corrupt object'), { code: 'HASH_MISMATCH' });
  reportSyncCycleFailure(corrupt);
  reportSyncCycleFailure(new Error('synthetic failure without a code'));
  reportSyncCycleFailure(Object.assign(new Error('signed out'), { code: 'needs-reauth' }));
  reportSyncCycleFailure(Object.assign(new Error('offline'), { code: 'NETWORK', retryable: true }));

  expect(mocks.reportIntegrityEvent.mock.calls.map(([code]) => code)).toEqual([
    'sync-blocked:HASH_MISMATCH',
    'sync-blocked:unknown',
  ]);
});

it('lets the coordinator retry a cycle whose local writes were not durable', async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const coordinator = new SyncEngineCoordinator({ retryRandom: () => 0.5 });
    coordinator.register({
      syncGenerationId: 'generation-local-flush',
      projectId: 'project-local-flush',
      async runCycle() {
        attempts += 1;
        if (attempts === 1) throw new SyncLocalFlushError(new Error('synthetic one-off failure'));
        return {
          pulledObjects: 0,
          publishedBlobs: 0,
          publishedSegments: 0,
          checkpointCreated: false,
          converged: true,
          requiresRepull: false,
        };
      },
    });

    coordinator.triggerManual('generation-local-flush');
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toBe(2);
    coordinator.shutdown();
  } finally {
    vi.useRealTimers();
  }
});
