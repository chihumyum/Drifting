import { describe, expect, it, vi } from 'vitest';

import {
  SyncEngineCoordinator,
  type RegisteredSyncGenerationRuntime,
  type SyncGenerationCycleStatus,
} from './engine';
import { ProductSyncRuntimeControl } from './product-runtime-control';

function runtime(syncGenerationId: string): RegisteredSyncGenerationRuntime {
  return {
    syncGenerationId,
    runCycle: vi.fn(async () => ({
      pulledObjects: 0,
      publishedBlobs: 0,
      publishedSegments: 0,
      checkpointCreated: false,
      converged: true,
      requiresRepull: false,
    })),
  };
}

describe('ProductSyncRuntimeControl', () => {
  it('publishes only sanitized diagnostics and detaches by coordinator identity', () => {
    const coordinator = new SyncEngineCoordinator();
    coordinator.register(runtime('sync-generation-b'));
    coordinator.register(runtime('sync-generation-a'));
    const control = new ProductSyncRuntimeControl();
    const observed = vi.fn();
    control.subscribe(observed);

    const detach = control.attach(coordinator);
    expect(control.getSnapshot()).toMatchObject({
      mounted: true,
      syncGenerationIds: ['sync-generation-a', 'sync-generation-b'],
      diagnostics: { generations: [] },
    });
    expect(JSON.stringify(control.getSnapshot())).not.toMatch(
      /token|secretRef|sessionUri|storageRef|contentJson/u,
    );

    detach();
    detach();
    expect(control.getSnapshot()).toEqual({ mounted: false, syncGenerationIds: [], diagnostics: null });
    expect(observed).toHaveBeenCalledTimes(2);
    coordinator.shutdown();
  });

  it('routes manual requests only to registered production SyncGenerations', () => {
    const coordinator = new SyncEngineCoordinator();
    coordinator.register(runtime('sync-generation-a'));
    const control = new ProductSyncRuntimeControl();
    const trigger = vi.spyOn(coordinator, 'triggerManual');
    const detach = control.attach(coordinator);

    control.triggerManual();
    control.triggerManual('sync-generation-a');
    expect(trigger).toHaveBeenNthCalledWith(1, 'sync-generation-a');
    expect(trigger).toHaveBeenNthCalledWith(2, 'sync-generation-a');

    detach();
    expect(() => control.triggerManual()).toThrow('not active');
    coordinator.shutdown();
  });

  it('waits for a fresh successful cycle with an empty durable frontier', async () => {
    let status: SyncGenerationCycleStatus = {
      phase: 'idle',
      cycleNumber: 0,
      lastPullSuccessAtMs: null,
      lastPublishSuccessAtMs: null,
      lastConvergedAtMs: null,
      lastOutcome: null,
      lastFailedPhase: null,
      lastError: null,
    };
    const coordinator = new SyncEngineCoordinator();
    coordinator.register({
      syncGenerationId: 'sync-generation-a',
      get status() {
        return status;
      },
      async runCycle() {
        status = {
          ...status,
          cycleNumber: status.cycleNumber + 1,
          lastOutcome: 'success',
          lastPullSuccessAtMs: 1,
          lastPublishSuccessAtMs: 1,
          lastConvergedAtMs: 1,
        };
        return {
          pulledObjects: 0,
          publishedBlobs: 0,
          publishedSegments: 0,
          checkpointCreated: false,
          converged: true,
          requiresRepull: false,
        };
      },
      async inspectPending() {
        return {
          pendingChangeSets: 0,
          pendingSegments: 0,
          pendingTransfers: 0,
          openGaps: 0,
          openConflicts: 0,
          quarantinedObjects: 0,
        };
      },
    });
    const control = new ProductSyncRuntimeControl();
    const detach = control.attach(coordinator);

    await expect(control.waitForConvergence({ timeoutMs: 1_000 })).resolves.toBeUndefined();
    expect(status.cycleNumber).toBe(1);

    detach();
    coordinator.shutdown();
  });
});
