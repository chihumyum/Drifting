import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fullJitterBackoffMs } from './backoff';
import {
  ACTIVE_FOREGROUND_POLL_INTERVAL_MS,
  IDLE_FOREGROUND_POLL_INTERVAL_MS,
  SyncScheduler,
  type SchedulerTrigger,
} from './scheduler';

async function drainMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('SyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a trailing two-second local-commit debounce', async () => {
    const observedTriggers: SchedulerTrigger[][] = [];
    const runCycle = vi.fn(
      async (_syncGenerationId: string, triggers: ReadonlySet<SchedulerTrigger>) => {
        observedTriggers.push([...triggers]);
      },
    );
    const scheduler = new SyncScheduler({ runCycle });
    scheduler.registerSyncGeneration('sync-generation-a');
    scheduler.triggerLocalCommit('sync-generation-a');
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.triggerLocalCommit('sync-generation-a');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(runCycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks();
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(observedTriggers).toEqual([['local-commit']]);
    scheduler.shutdown();
  });

  it('runs globally single-flight and round-robins before rerunning one SyncGeneration', async () => {
    const first = deferred<void>();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const runCycle = vi.fn(async (syncGenerationId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(syncGenerationId);
      if (order.length === 1) await first.promise;
      active -= 1;
    });
    const scheduler = new SyncScheduler({ runCycle });
    for (const syncGenerationId of ['sync-generation-a', 'sync-generation-b', 'sync-generation-c']) scheduler.registerSyncGeneration(syncGenerationId);
    scheduler.triggerManual('sync-generation-a');
    scheduler.triggerManual('sync-generation-a');
    scheduler.triggerManual('sync-generation-b');
    scheduler.triggerManual('sync-generation-c');
    expect(order).toEqual(['sync-generation-a']);
    first.resolve();
    await drainMicrotasks(20);
    expect(order).toEqual(['sync-generation-a', 'sync-generation-b', 'sync-generation-c', 'sync-generation-a']);
    expect(maximumActive).toBe(1);
    scheduler.shutdown();
  });

  it('cancels the active network lane offline and resumes queued SyncGenerations immediately online', async () => {
    const aborted: string[] = [];
    const order: string[] = [];
    const runCycle = vi.fn(
      (syncGenerationId: string, _triggers: ReadonlySet<string>, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          order.push(syncGenerationId);
          if (order.length > 1) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => {
            aborted.push(syncGenerationId);
            reject(signal.reason);
          });
        }),
    );
    const scheduler = new SyncScheduler({ runCycle });
    scheduler.registerSyncGeneration('sync-generation-a');
    scheduler.registerSyncGeneration('sync-generation-b');
    scheduler.triggerManual('sync-generation-a');
    scheduler.setOnline(false);
    scheduler.triggerLocalCommit('sync-generation-b');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aborted).toEqual(['sync-generation-a']);
    expect(order).toEqual(['sync-generation-a']);
    scheduler.setOnline(true);
    await drainMicrotasks(20);
    expect(order).toContain('sync-generation-b');
    scheduler.shutdown();
  });

  it('supports delayed retry, foreground polling, and immediate self-publish pull', async () => {
    const triggers: string[][] = [];
    const runCycle = vi.fn(async (_syncGenerationId: string, reasonSet: ReadonlySet<string>) => {
      triggers.push([...reasonSet]);
      return { requiresRepull: triggers.length === 1 };
    });
    const scheduler = new SyncScheduler({ runCycle });
    scheduler.registerSyncGeneration('sync-generation-a');
    scheduler.scheduleRetry('sync-generation-a', 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(runCycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks(20);
    expect(triggers).toEqual([['retry'], ['self-publish']]);

    scheduler.setForeground(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await drainMicrotasks();
    expect(triggers[triggers.length - 1]).toEqual(['foreground-poll']);
    scheduler.shutdown();
  });

  it('adapts polling per SyncGeneration without accelerating idle projects', async () => {
    const startedAtMs = Date.now();
    const observed: Array<{
      syncGenerationId: string;
      atMs: number;
      triggers: SchedulerTrigger[];
    }> = [];
    const scheduler = new SyncScheduler({
      runCycle: async (syncGenerationId, triggers) => {
        observed.push({
          syncGenerationId,
          atMs: Date.now() - startedAtMs,
          triggers: [...triggers],
        });
      },
    });
    scheduler.registerSyncGeneration('sync-generation-active');
    scheduler.registerSyncGeneration('sync-generation-idle');
    scheduler.setForeground(true);
    scheduler.triggerLocalCommit('sync-generation-active');

    await vi.advanceTimersByTimeAsync(30_000);
    await drainMicrotasks(20);
    expect(
      observed
        .filter((entry) => entry.syncGenerationId === 'sync-generation-active')
        .map((entry) => [entry.atMs, entry.triggers]),
    ).toEqual([
      [2_000, ['local-commit']],
      [5_000, ['foreground-poll']],
      [10_000, ['foreground-poll']],
      [15_000, ['foreground-poll']],
      [20_000, ['foreground-poll']],
      [25_000, ['foreground-poll']],
      [30_000, ['foreground-poll']],
    ]);
    expect(observed.some((entry) => entry.syncGenerationId === 'sync-generation-idle')).toBe(false);

    await vi.advanceTimersByTimeAsync(90_000);
    await drainMicrotasks(20);
    expect(
      observed
        .filter(
          (entry) =>
            entry.syncGenerationId === 'sync-generation-active' &&
            entry.triggers.includes('foreground-poll'),
        )
        .map((entry) => entry.atMs),
    ).toEqual([5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 60_000, 90_000, 120_000]);
    expect(
      observed
        .filter(
          (entry) =>
            entry.syncGenerationId === 'sync-generation-idle' &&
            entry.triggers.includes('foreground-poll'),
        )
        .map((entry) => entry.atMs),
    ).toEqual([60_000, 120_000]);

    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.triggerLocalCommit('sync-generation-active');
    await vi.advanceTimersByTimeAsync(5_000);
    await drainMicrotasks(20);
    expect(
      observed
        .filter((entry) => entry.syncGenerationId === 'sync-generation-active')
        .slice(-2)
        .map((entry) => [entry.atMs, entry.triggers]),
    ).toEqual([
      [123_000, ['local-commit']],
      [126_000, ['foreground-poll']],
    ]);
    scheduler.shutdown();
  });

  it('removes poll-only work on blur and rebuilds an idle deadline on focus', async () => {
    const first = deferred<void>();
    const observed: Array<{ syncGenerationId: string; atMs: number }> = [];
    const startedAtMs = Date.now();
    const scheduler = new SyncScheduler({
      runCycle: async (syncGenerationId) => {
        observed.push({ syncGenerationId, atMs: Date.now() - startedAtMs });
        if (observed.length === 1) await first.promise;
      },
    });
    scheduler.registerSyncGeneration('sync-generation-a');
    scheduler.registerSyncGeneration('sync-generation-b');
    scheduler.setForeground(true);

    await vi.advanceTimersByTimeAsync(IDLE_FOREGROUND_POLL_INTERVAL_MS);
    expect(observed).toEqual([{ syncGenerationId: 'sync-generation-a', atMs: 60_000 }]);
    scheduler.setForeground(false);
    first.resolve();
    await drainMicrotasks(20);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(observed).toHaveLength(1);

    scheduler.setForeground(true);
    await vi.advanceTimersByTimeAsync(IDLE_FOREGROUND_POLL_INTERVAL_MS - 1);
    expect(observed).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks(20);
    expect(observed.slice(1)).toEqual([
      { syncGenerationId: 'sync-generation-b', atMs: 420_000 },
      { syncGenerationId: 'sync-generation-a', atMs: 420_000 },
    ]);
    scheduler.shutdown();
  });

  it('keeps Retry-After as a hard floor for every queued wake trigger', async () => {
    const startedAtMs = Date.now();
    const observed: Array<{ atMs: number; triggers: SchedulerTrigger[] }> = [];
    const scheduler = new SyncScheduler({
      runCycle: async (_syncGenerationId, triggers) => {
        observed.push({ atMs: Date.now() - startedAtMs, triggers: [...triggers] });
      },
    });
    scheduler.registerSyncGeneration('sync-generation-retry');
    scheduler.setForeground(true);
    scheduler.scheduleRetry('sync-generation-retry', 25_000);
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.triggerLocalCommit('sync-generation-retry');
    scheduler.triggerManual('sync-generation-retry');
    scheduler.triggerStart('sync-generation-retry');
    scheduler.triggerResume('sync-generation-retry');
    scheduler.triggerLifecycleFlush('sync-generation-retry');
    scheduler.setOnline(false);
    scheduler.setOnline(true);

    await vi.advanceTimersByTimeAsync(23_999);
    expect(observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await drainMicrotasks(20);
    expect(observed).toEqual([
      {
        atMs: 25_000,
        triggers: [
          'retry',
          'local-commit',
          'manual',
          'start',
          'resume',
          'lifecycle-flush',
          'online',
        ],
      },
    ]);
    await vi.advanceTimersByTimeAsync(ACTIVE_FOREGROUND_POLL_INTERVAL_MS);
    await drainMicrotasks(20);
    expect(observed[1]).toEqual({ atMs: 30_000, triggers: ['foreground-poll'] });
    scheduler.shutdown();
  });

  it('coalesces missed foreground intervals after a long single-flight cycle', async () => {
    const first = deferred<void>();
    const observed: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const scheduler = new SyncScheduler({
      runCycle: async (syncGenerationId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        observed.push(syncGenerationId);
        if (observed.length === 1) await first.promise;
        active -= 1;
      },
    });
    scheduler.registerSyncGeneration('sync-generation-a');
    scheduler.registerSyncGeneration('sync-generation-b');
    scheduler.setForeground(true);

    await vi.advanceTimersByTimeAsync(IDLE_FOREGROUND_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(observed).toEqual(['sync-generation-a']);
    first.resolve();
    await drainMicrotasks(40);
    expect(observed).toEqual([
      'sync-generation-a',
      'sync-generation-b',
      'sync-generation-a',
    ]);
    expect(maximumActive).toBe(1);
    scheduler.shutdown();
  });
});

describe('fullJitterBackoffMs', () => {
  it('starts at one second, caps at five minutes, and respects Retry-After', () => {
    expect(fullJitterBackoffMs({ failureAttempt: 0, random: () => 0.5 })).toBe(500);
    expect(fullJitterBackoffMs({ failureAttempt: 30, random: () => 0.999 })).toBeLessThanOrEqual(
      300_000,
    );
    expect(
      fullJitterBackoffMs({ failureAttempt: 2, random: () => 0, retryAfterMs: 25_000 }),
    ).toBe(25_000);
  });
});
