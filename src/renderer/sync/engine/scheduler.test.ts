import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fullJitterBackoffMs } from './backoff';
import { SyncScheduler, type SchedulerTrigger } from './scheduler';

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
