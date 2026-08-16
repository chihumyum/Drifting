export const LOCAL_COMMIT_DEBOUNCE_MS = 2_000;
export const ACTIVE_FOREGROUND_POLL_INTERVAL_MS = 5_000;
export const WARM_FOREGROUND_POLL_INTERVAL_MS = 30_000;
export const IDLE_FOREGROUND_POLL_INTERVAL_MS = 60_000;
export const ACTIVE_EDIT_WINDOW_MS = 30_000;
export const WARM_ACTIVITY_WINDOW_MS = 120_000;

export type SchedulerTrigger =
  | 'local-commit'
  | 'manual'
  | 'retry'
  | 'start'
  | 'resume'
  | 'online'
  | 'foreground-poll'
  | 'lifecycle-flush'
  | 'self-publish';

export interface SchedulerClock {
  nowMs(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ScheduledCycleResult {
  readonly requiresRepull?: boolean;
}

export interface SyncSchedulerOptions {
  readonly runCycle: (
    syncGenerationId: string,
    triggers: ReadonlySet<SchedulerTrigger>,
    signal: AbortSignal,
  ) => Promise<ScheduledCycleResult | void>;
  readonly clock?: SchedulerClock;
  readonly onCycleError?: (syncGenerationId: string, error: unknown) => void;
}

interface PendingSyncGenerationCycle {
  dueAtMs: number;
  triggers: Set<SchedulerTrigger>;
  retryNotBeforeMs: number | null;
}

interface ForegroundPollState {
  lastAuthoredActivityAtMs: number | null;
  nextForegroundPollAtMs: number | null;
}

const defaultClock: SchedulerClock = {
  nowMs: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function assertDelay(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('scheduler delay must be a non-negative safe integer');
  }
}

export class SyncScheduler {
  private readonly runCycle: SyncSchedulerOptions['runCycle'];
  private readonly clock: SchedulerClock;
  private readonly onCycleError?: SyncSchedulerOptions['onCycleError'];
  private readonly generationOrder: string[] = [];
  private readonly pending = new Map<string, PendingSyncGenerationCycle>();
  private readonly foregroundPolls = new Map<string, ForegroundPollState>();
  private wakeTimer: unknown | null = null;
  private active: { syncGenerationId: string; controller: AbortController } | null = null;
  private lastSyncGenerationId: string | null = null;
  private online = true;
  private suspended = false;
  private foreground = false;
  private stopped = false;

  constructor(options: SyncSchedulerOptions) {
    this.runCycle = options.runCycle;
    this.clock = options.clock ?? defaultClock;
    this.onCycleError = options.onCycleError;
  }

  registerSyncGeneration(syncGenerationId: string): void {
    if (!syncGenerationId) throw new TypeError('syncGenerationId must not be empty');
    if (this.generationOrder.includes(syncGenerationId)) return;
    this.generationOrder.push(syncGenerationId);
    this.foregroundPolls.set(syncGenerationId, {
      lastAuthoredActivityAtMs: null,
      nextForegroundPollAtMs: this.foreground
        ? this.clock.nowMs() + IDLE_FOREGROUND_POLL_INTERVAL_MS
        : null,
    });
    this.scheduleWake();
  }

  unregisterSyncGeneration(syncGenerationId: string): void {
    const index = this.generationOrder.indexOf(syncGenerationId);
    if (index >= 0) this.generationOrder.splice(index, 1);
    this.pending.delete(syncGenerationId);
    this.foregroundPolls.delete(syncGenerationId);
    if (this.active?.syncGenerationId === syncGenerationId) this.active.controller.abort('sync-generation-unregistered');
    if (this.lastSyncGenerationId === syncGenerationId) this.lastSyncGenerationId = null;
    this.scheduleWake();
  }

  triggerStart(syncGenerationId?: string): void {
    this.triggerImmediate(syncGenerationId, 'start');
  }

  triggerResume(syncGenerationId?: string): void {
    this.triggerImmediate(syncGenerationId, 'resume');
  }

  triggerManual(syncGenerationId: string): void {
    this.queue(syncGenerationId, 'manual', this.clock.nowMs());
  }

  triggerLifecycleFlush(syncGenerationId?: string): void {
    this.triggerImmediate(syncGenerationId, 'lifecycle-flush');
  }

  triggerLocalCommit(syncGenerationId: string): void {
    this.assertRegistered(syncGenerationId);
    const nowMs = this.clock.nowMs();
    this.noteAuthoredActivity(syncGenerationId, nowMs);
    const dueAtMs = nowMs + LOCAL_COMMIT_DEBOUNCE_MS;
    const existing = this.pending.get(syncGenerationId);
    if (existing && [...existing.triggers].every((trigger) => trigger === 'local-commit')) {
      existing.dueAtMs = dueAtMs;
      existing.triggers.add('local-commit');
      this.scheduleWake();
      return;
    }
    this.queue(syncGenerationId, 'local-commit', dueAtMs);
  }

  scheduleRetry(syncGenerationId: string, delayMs: number): void {
    assertDelay(delayMs);
    this.assertRegistered(syncGenerationId);
    const retryAtMs = this.clock.nowMs() + delayMs;
    const existing = this.pending.get(syncGenerationId);
    if (existing) {
      existing.retryNotBeforeMs = Math.max(existing.retryNotBeforeMs ?? 0, retryAtMs);
      existing.dueAtMs = Math.max(existing.dueAtMs, existing.retryNotBeforeMs);
      existing.triggers.add('retry');
    } else {
      this.pending.set(syncGenerationId, {
        dueAtMs: retryAtMs,
        triggers: new Set(['retry']),
        retryNotBeforeMs: retryAtMs,
      });
    }
    const poll = this.foregroundPolls.get(syncGenerationId);
    if (this.foreground && poll) {
      poll.nextForegroundPollAtMs =
        retryAtMs + this.foregroundPollIntervalMs(poll, retryAtMs);
    }
    this.scheduleWake();
  }

  setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    if (!online) {
      this.active?.controller.abort('offline');
      this.clearWakeTimer();
      return;
    }
    this.triggerImmediate(undefined, 'online');
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) {
      this.active?.controller.abort('suspended');
      this.clearWakeTimer();
      return;
    }
    this.triggerImmediate(undefined, 'resume');
  }

  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    const nowMs = this.clock.nowMs();
    for (const syncGenerationId of this.generationOrder) {
      const poll = this.foregroundPolls.get(syncGenerationId);
      if (!poll) continue;
      if (!foreground) {
        poll.nextForegroundPollAtMs = null;
        const pending = this.pending.get(syncGenerationId);
        if (pending?.triggers.size === 1 && pending.triggers.has('foreground-poll')) {
          this.pending.delete(syncGenerationId);
        }
        continue;
      }
      const retryNotBeforeMs = this.pending.get(syncGenerationId)?.retryNotBeforeMs ?? nowMs;
      const anchorMs = Math.max(nowMs, retryNotBeforeMs);
      poll.nextForegroundPollAtMs =
        anchorMs + this.foregroundPollIntervalMs(poll, anchorMs);
    }
    this.scheduleWake();
  }

  shutdown(): void {
    this.stopped = true;
    this.pending.clear();
    this.foregroundPolls.clear();
    this.active?.controller.abort('scheduler-shutdown');
    this.clearWakeTimer();
  }

  get snapshot(): {
    readonly activeSyncGenerationId: string | null;
    readonly pendingSyncGenerationIds: readonly string[];
    readonly online: boolean;
    readonly suspended: boolean;
  } {
    return Object.freeze({
      activeSyncGenerationId: this.active?.syncGenerationId ?? null,
      pendingSyncGenerationIds: Object.freeze([...this.pending.keys()]),
      online: this.online,
      suspended: this.suspended,
    });
  }

  private triggerImmediate(syncGenerationId: string | undefined, trigger: SchedulerTrigger): void {
    if (syncGenerationId) {
      this.queue(syncGenerationId, trigger, this.clock.nowMs());
      return;
    }
    for (const registeredSyncGenerationId of this.generationOrder) {
      this.queue(registeredSyncGenerationId, trigger, this.clock.nowMs(), false);
    }
    this.scheduleWake();
  }

  private queue(
    syncGenerationId: string,
    trigger: SchedulerTrigger,
    dueAtMs: number,
    wake = true,
  ): void {
    this.assertRegistered(syncGenerationId);
    assertDelay(dueAtMs);
    const existing = this.pending.get(syncGenerationId);
    if (existing) {
      const requestedDueAtMs = Math.min(existing.dueAtMs, dueAtMs);
      existing.dueAtMs = existing.retryNotBeforeMs === null
        ? requestedDueAtMs
        : Math.max(requestedDueAtMs, existing.retryNotBeforeMs);
      existing.triggers.add(trigger);
    } else {
      this.pending.set(syncGenerationId, {
        dueAtMs,
        triggers: new Set([trigger]),
        retryNotBeforeMs: null,
      });
    }
    if (wake) this.scheduleWake();
  }

  private assertRegistered(syncGenerationId: string): void {
    if (!this.generationOrder.includes(syncGenerationId)) {
      throw new Error(`SyncGeneration ${syncGenerationId} is not registered with the sync scheduler`);
    }
  }

  private canRun(): boolean {
    return !this.stopped && this.online && !this.suspended;
  }

  private foregroundPollIntervalMs(poll: ForegroundPollState, atMs: number): number {
    const lastActivityAtMs = poll.lastAuthoredActivityAtMs;
    if (lastActivityAtMs === null) return IDLE_FOREGROUND_POLL_INTERVAL_MS;
    const ageMs = Math.max(0, atMs - lastActivityAtMs);
    if (ageMs < ACTIVE_EDIT_WINDOW_MS) return ACTIVE_FOREGROUND_POLL_INTERVAL_MS;
    if (ageMs < WARM_ACTIVITY_WINDOW_MS) return WARM_FOREGROUND_POLL_INTERVAL_MS;
    return IDLE_FOREGROUND_POLL_INTERVAL_MS;
  }

  private noteAuthoredActivity(syncGenerationId: string, nowMs: number): void {
    const poll = this.foregroundPolls.get(syncGenerationId);
    if (!poll) return;
    poll.lastAuthoredActivityAtMs = nowMs;
    if (!this.foreground) return;
    const retryNotBeforeMs = this.pending.get(syncGenerationId)?.retryNotBeforeMs;
    const candidateAtMs = (retryNotBeforeMs ?? nowMs) + ACTIVE_FOREGROUND_POLL_INTERVAL_MS;
    poll.nextForegroundPollAtMs = retryNotBeforeMs === null || retryNotBeforeMs === undefined
      ? Math.min(poll.nextForegroundPollAtMs ?? candidateAtMs, candidateAtMs)
      : candidateAtMs;
  }

  private enqueueForegroundPollsIfDue(): void {
    if (!this.foreground) return;
    const nowMs = this.clock.nowMs();
    for (const syncGenerationId of this.generationOrder) {
      const poll = this.foregroundPolls.get(syncGenerationId);
      if (!poll) continue;
      const dueAtMs = poll.nextForegroundPollAtMs;
      if (dueAtMs === null || nowMs < dueAtMs) continue;
      const pending = this.pending.get(syncGenerationId);
      if (pending) {
        const anchorMs = Math.max(nowMs, pending.dueAtMs);
        poll.nextForegroundPollAtMs =
          anchorMs + this.foregroundPollIntervalMs(poll, anchorMs);
        continue;
      }
      this.queue(syncGenerationId, 'foreground-poll', nowMs, false);
      poll.nextForegroundPollAtMs = nowMs + this.foregroundPollIntervalMs(poll, nowMs);
    }
  }

  private selectDueSyncGeneration(): { syncGenerationId: string; job: PendingSyncGenerationCycle } | null {
    const now = this.clock.nowMs();
    if (this.generationOrder.length === 0) return null;
    const lastIndex = this.lastSyncGenerationId ? this.generationOrder.indexOf(this.lastSyncGenerationId) : -1;
    for (let offset = 1; offset <= this.generationOrder.length; offset += 1) {
      const syncGenerationId = this.generationOrder[(lastIndex + offset) % this.generationOrder.length]!;
      const job = this.pending.get(syncGenerationId);
      if (job && job.dueAtMs <= now) return { syncGenerationId, job };
    }
    return null;
  }

  private scheduleWake(): void {
    this.clearWakeTimer();
    if (!this.canRun() || this.active) return;
    this.enqueueForegroundPollsIfDue();
    const selected = this.selectDueSyncGeneration();
    if (selected) {
      this.start(selected.syncGenerationId, selected.job);
      return;
    }
    const dueTimes = [...this.pending.values()].map((job) => job.dueAtMs);
    if (this.foreground) {
      for (const poll of this.foregroundPolls.values()) {
        if (poll.nextForegroundPollAtMs !== null) dueTimes.push(poll.nextForegroundPollAtMs);
      }
    }
    if (dueTimes.length === 0) return;
    const nextDue = Math.min(...dueTimes);
    this.wakeTimer = this.clock.setTimeout(
      () => {
        this.wakeTimer = null;
        this.scheduleWake();
      },
      Math.max(0, nextDue - this.clock.nowMs()),
    );
  }

  private start(syncGenerationId: string, job: PendingSyncGenerationCycle): void {
    this.pending.delete(syncGenerationId);
    const controller = new AbortController();
    this.active = { syncGenerationId, controller };
    const triggers = new Set(job.triggers);
    let cycle: Promise<ScheduledCycleResult | void>;
    try {
      cycle = this.runCycle(syncGenerationId, triggers, controller.signal);
    } catch (error) {
      cycle = Promise.reject(error);
    }
    void cycle
      .then((result) => {
        if (result?.requiresRepull && !controller.signal.aborted && !this.stopped) {
          this.queue(syncGenerationId, 'self-publish', this.clock.nowMs(), false);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) this.onCycleError?.(syncGenerationId, error);
      })
      .finally(() => {
        if (this.active?.controller === controller) this.active = null;
        this.lastSyncGenerationId = syncGenerationId;
        this.scheduleWake();
      });
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer === null) return;
    this.clock.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }
}
