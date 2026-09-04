import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthoredCommitEvent } from '../journal';
import {
  installSyncEngineCoordinatorRuntime,
  SyncEngineCoordinator,
  type RegisteredSyncGenerationRuntime,
  type SyncEngineRuntimeSignals,
} from './coordinator';
import type { SyncGenerationCycleStatus } from './cycle';
import type { SchedulerTrigger } from './scheduler';

async function drainMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function status(cycleNumber = 0): SyncGenerationCycleStatus {
  return {
    phase: 'idle',
    cycleNumber,
    lastPullSuccessAtMs: cycleNumber > 0 ? Date.now() : null,
    lastPublishSuccessAtMs: cycleNumber > 0 ? Date.now() : null,
    lastConvergedAtMs: cycleNumber > 0 ? Date.now() : null,
    lastOutcome: cycleNumber > 0 ? 'success' : null,
    lastFailedPhase: null,
    lastError: null,
  };
}

function runtime(syncGenerationId: string, observed: SchedulerTrigger[][]): RegisteredSyncGenerationRuntime {
  let current = status();
  return {
    syncGenerationId,
    get status() {
      return current;
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
    async runCycle(triggers) {
      observed.push([...triggers]);
      current = status(current.cycleNumber + 1);
      return {
        pulledObjects: 0,
        publishedBlobs: 0,
        publishedSegments: 0,
        checkpointCreated: false,
        converged: true,
        requiresRepull: false,
      };
    },
  };
}

function fakeSignals() {
  let authored: ((event: AuthoredCommitEvent) => void) | null = null;
  let lifecycleFlush: import('../../lib/persistence-lifecycle').SyncEngineLifecycleHook | null = null;
  let ready: ((event: 'ready' | 'resumed') => void) | null = null;
  let providerTransportAllowed = true;
  const windowListeners = new Map<string, () => void>();
  const signals: SyncEngineRuntimeSignals = {
    authoredCommits(listener) {
      authored = listener;
      return () => {
        authored = null;
      };
    },
    installLifecycleHook(hook) {
      lifecycleFlush = hook;
      return () => {
        lifecycleFlush = null;
      };
    },
    lifecycle: {
      onReadyOrResume(listener) {
        ready = listener;
        return () => {
          ready = null;
        };
      },
    },
    canUseProviderTransport: () => providerTransportAllowed,
    addWindowListener(event, listener) {
      windowListeners.set(event, listener);
      return () => windowListeners.delete(event);
    },
  };
  return {
    signals,
    authored: (event: AuthoredCommitEvent) => authored?.(event),
    flush: (
      reason: import('../../lib/persistence-lifecycle').SyncEngineLifecycleReason = 'suspended',
    ) => lifecycleFlush?.(reason) ?? Promise.resolve(),
    resume: () => ready?.('resumed'),
    allowProviderTransport: (allowed: boolean) => {
      providerTransportAllowed = allowed;
    },
    window: (event: 'online' | 'offline' | 'focus' | 'blur') => windowListeners.get(event)?.(),
  };
}

describe('SyncEngineCoordinator runtime integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps sanitized runtime progress bound to its project workspace', () => {
    const coordinator = new SyncEngineCoordinator();
    const projectRuntime = runtime('sync-generation-a', []);
    Object.assign(projectRuntime, { projectId: 'project-a' });
    coordinator.register(projectRuntime);

    expect(coordinator.diagnostics().generations[0]).toMatchObject({
      syncGenerationId: 'sync-generation-a',
      projectId: 'project-a',
    });
  });

  it('projects transfer counters without provider refs or object identities', () => {
    const coordinator = new SyncEngineCoordinator();
    const projectRuntime = runtime('sync-generation-progress', []);
    Object.assign(projectRuntime, {
      projectId: 'project-progress',
      transferProgress: {
        stage: 'download',
        completedObjects: 2,
        totalObjects: 4,
        transferredBytes: 256,
        totalBytes: 1024,
        totalKnown: true,
      },
    });
    coordinator.register(projectRuntime);

    expect(coordinator.diagnostics().generations[0]?.transferProgress).toEqual({
      stage: 'download',
      completedObjects: 2,
      totalObjects: 4,
      transferredBytes: 256,
      totalBytes: 1024,
      totalKnown: true,
    });
    expect(JSON.stringify(coordinator.diagnostics())).not.toMatch(
      /logicalKeyId|objectId|transferId|storageRef/u,
    );
  });

  it('wires authored debounce, lifecycle, resume and online signals without doing work in callbacks', async () => {
    const observed: SchedulerTrigger[][] = [];
    const coordinator = new SyncEngineCoordinator();
    coordinator.register(runtime('sync-generation-a', observed));
    const fake = fakeSignals();
    const uninstall = installSyncEngineCoordinatorRuntime(coordinator, fake.signals);
    await drainMicrotasks();
    observed.length = 0;

    fake.authored({
      command: 'node.rename',
      projectId: 'project-a',
      syncGenerationId: 'sync-generation-a',
      changeSetId: 'writer:epoch:1',
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(observed).toEqual([['local-commit']]);

    await fake.flush('database-switch');
    await drainMicrotasks();
    expect(observed[observed.length - 1]).toEqual(['lifecycle-flush']);
    await fake.flush('suspended');
    expect(coordinator.diagnostics().suspended).toBe(true);
    fake.window('offline');
    fake.resume();
    await drainMicrotasks();
    expect(observed[observed.length - 1]).toEqual(['lifecycle-flush']);
    fake.window('online');
    await drainMicrotasks();
    expect(observed[observed.length - 1]).toEqual(expect.arrayContaining(['resume', 'online']));

    const diagnostics = coordinator.diagnostics();
    expect(diagnostics).toMatchObject({
      activeSyncGenerationId: null,
      online: true,
      suspended: false,
      generations: [{ syncGenerationId: 'sync-generation-a', phase: 'idle', lastOutcome: 'success' }],
    });
    uninstall();
  });

  it('starts a mounted project immediately and limits adaptive polling to the foreground', async () => {
    const observed: SchedulerTrigger[][] = [];
    const coordinator = new SyncEngineCoordinator();
    coordinator.register(runtime('sync-generation-active', observed));
    const fake = fakeSignals();
    const uninstall = installSyncEngineCoordinatorRuntime(coordinator, fake.signals);
    await drainMicrotasks();

    expect(observed).toEqual([['start']]);
    observed.length = 0;
    fake.authored({
      command: 'node.prose.update',
      projectId: 'project-active',
      syncGenerationId: 'sync-generation-active',
      changeSetId: 'writer:epoch:1',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await drainMicrotasks();
    expect(observed).toEqual([['local-commit']]);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(observed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(observed[1]).toEqual(['foreground-poll']);

    fake.window('blur');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(observed).toHaveLength(2);

    fake.window('focus');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(observed).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(observed[2]).toEqual(['foreground-poll']);
    uninstall();
  });

  it('keeps multiple registered SyncGenerations globally single-flight and round-robin', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const coordinator = new SyncEngineCoordinator();
    for (const syncGenerationId of ['sync-generation-a', 'sync-generation-b', 'sync-generation-c']) {
      coordinator.register({
        syncGenerationId,
        async runCycle() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          order.push(syncGenerationId);
          if (order.length === 1) await first;
          active -= 1;
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
    }
    coordinator.triggerManual('sync-generation-a');
    coordinator.triggerManual('sync-generation-a');
    coordinator.triggerManual('sync-generation-b');
    coordinator.triggerManual('sync-generation-c');
    expect(order).toEqual(['sync-generation-a']);
    releaseFirst();
    await drainMicrotasks(40);
    expect(order).toEqual(['sync-generation-a', 'sync-generation-b', 'sync-generation-c', 'sync-generation-a']);
    expect(maximumActive).toBe(1);
    coordinator.shutdown();
  });

  it('does not open a provider while the personal-cloud capability gate is closed', async () => {
    const observed: SchedulerTrigger[][] = [];
    const coordinator = new SyncEngineCoordinator();
    coordinator.register(runtime('sync-generation-gated', observed));
    const fake = fakeSignals();
    fake.allowProviderTransport(false);
    const uninstall = installSyncEngineCoordinatorRuntime(coordinator, fake.signals);
    await drainMicrotasks();

    expect(observed).toEqual([]);
    expect(coordinator.diagnostics().online).toBe(false);

    fake.allowProviderTransport(true);
    fake.window('online');
    await drainMicrotasks();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(expect.arrayContaining(['start', 'online']));
    uninstall();
  });

  it('schedules retryable failures with Retry-After and does not spin immediately', async () => {
    let attempts = 0;
    const coordinator = new SyncEngineCoordinator({ retryRandom: () => 0 });
    coordinator.register({
      syncGenerationId: 'sync-generation-retry',
      async runCycle() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('rate limited'), {
            code: 'rate-limited',
            retryable: true,
            retryAfterMs: 2_500,
          });
        }
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
    coordinator.triggerManual('sync-generation-retry');
    await drainMicrotasks();
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(attempts).toBe(2);
    coordinator.shutdown();
  });
});
