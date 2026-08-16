import { describe, expect, it, vi } from 'vitest';

import { SyncGenerationCycleLane, type DurableCycleOperations } from './cycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function durable(overrides: Partial<DurableCycleOperations> = {}): DurableCycleOperations {
  return {
    prepare: async () => undefined,
    ingest: async () => undefined,
    apply: async () => undefined,
    checkpoint: async () => false,
    inspectPending: async () => ({
      hasPending: false,
      hasGap: false,
      hasConflict: false,
      hasQuarantine: false,
    }),
    ...overrides,
  };
}

describe('SyncGenerationCycleLane', () => {
  it('runs the provider-neutral lanes in order and reports true convergence', async () => {
    const phases: string[] = [];
    let now = 1_000;
    const lane = new SyncGenerationCycleLane({
      syncGenerationId: 'sync-generation-a',
      durable: durable(),
      provider: {
        pull: async () => ({ objectCount: 2 }),
        publishBlobs: async () => ({ objectCount: 1 }),
        publishSegments: async () => ({ objectCount: 1 }),
      },
      clock: { nowMs: () => ++now },
      onPhaseChange: (phase) => phases.push(phase),
    });
    const result = await lane.run(new AbortController().signal);
    expect(result).toEqual({
      pulledObjects: 2,
      publishedBlobs: 1,
      publishedSegments: 1,
      checkpointCreated: false,
      converged: true,
      requiresRepull: true,
    });
    expect(phases).toEqual([
      'preparing',
      'pulling',
      'ingesting',
      'applying',
      'publishing-blobs',
      'publishing-segments',
      'checkpointing',
      'idle',
    ]);
    expect(lane.status.lastPullSuccessAtMs).not.toBeNull();
    expect(lane.status.lastPublishSuccessAtMs).not.toBeNull();
    expect(lane.status.lastConvergedAtMs).not.toBeNull();
  });

  it('enforces per-SyncGeneration single flight even when invoked outside the scheduler', async () => {
    const gate = deferred<void>();
    const lane = new SyncGenerationCycleLane({
      syncGenerationId: 'sync-generation-a',
      durable: durable({ prepare: () => gate.promise }),
      provider: {
        pull: async () => ({ objectCount: 0 }),
        publishBlobs: async () => ({ objectCount: 0 }),
        publishSegments: async () => ({ objectCount: 0 }),
      },
      clock: { nowMs: () => 0 },
    });
    const running = lane.run(new AbortController().signal);
    await expect(lane.run(new AbortController().signal)).rejects.toThrow('active sync cycle');
    gate.resolve();
    await running;
  });

  it('returns to idle and preserves the exact failed phase', async () => {
    const failure = new Error('provider unavailable');
    const lane = new SyncGenerationCycleLane({
      syncGenerationId: 'sync-generation-a',
      durable: durable(),
      provider: {
        pull: async () => {
          throw failure;
        },
        publishBlobs: vi.fn(),
        publishSegments: vi.fn(),
      },
      clock: { nowMs: () => 0 },
    });
    await expect(lane.run(new AbortController().signal)).rejects.toBe(failure);
    expect(lane.status).toMatchObject({
      phase: 'idle',
      lastOutcome: 'failed',
      lastFailedPhase: 'pulling',
      lastError: failure,
    });
  });
});
