export const LOCAL_COMMIT_DEBOUNCE_MS = 2_000;
export const FOREGROUND_POLL_INTERVAL_MS = 60_000;

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
  private wakeTimer: unknown | null = null;
  private active: { syncGenerationId: string; controller: AbortController } | null = null;
  private lastSyncGenerationId: string | null = null;
  private online = true;
  private suspended = false;
  private foreground = false;
  private nextForegroundPollAtMs: number | null = null;
  private stopped = false;

  constructor(options: SyncSchedulerOptions) {
    this.runCycle = options.runCycle;
    this.clock = options.clock ?? defaultClock;
    this.onCycleError = options.onCycleError;
  }

  registerSyncGeneration(syncGenerationId: string): void {
    if (!syncGenerationId) throw new TypeError('syncGenerationId must not be empty');
    if (!this.generationOrder.includes(syncGenerationId)) this.generationOrder.push(syncGenerationId);
  }

  unregisterSyncGeneration(syncGenerationId: string): void {
    const index = this.generationOrder.indexOf(syncGenerationId);
    if (index >= 0) this.generationOrder.splice(index, 1);
    this.pending.delete(syncGenerationId);
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
    const dueAtMs = this.clock.nowMs() + LOCAL_COMMIT_DEBOUNCE_MS;
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
    this.queue(syncGenerationId, 'retry', this.clock.nowMs() + delayMs);
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
    this.nextForegroundPollAtMs = foreground
      ? this.clock.nowMs() + FOREGROUND_POLL_INTERVAL_MS
      : null;
    this.scheduleWake();
  }

  shutdown(): void {
    this.stopped = true;
    this.pending.clear();
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
      existing.dueAtMs = Math.min(existing.dueAtMs, dueAtMs);
      existing.triggers.add(trigger);
    } else {
      this.pending.set(syncGenerationId, { dueAtMs, triggers: new Set([trigger]) });
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

  private enqueueForegroundPollIfDue(): void {
    const dueAt = this.nextForegroundPollAtMs;
    if (!this.foreground || dueAt === null || this.clock.nowMs() < dueAt) return;
    for (const syncGenerationId of this.generationOrder) {
      this.queue(syncGenerationId, 'foreground-poll', this.clock.nowMs(), false);
    }
    const elapsed = this.clock.nowMs() - dueAt;
    const intervals = Math.floor(elapsed / FOREGROUND_POLL_INTERVAL_MS) + 1;
    this.nextForegroundPollAtMs = dueAt + intervals * FOREGROUND_POLL_INTERVAL_MS;
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
    this.enqueueForegroundPollIfDue();
    const selected = this.selectDueSyncGeneration();
    if (selected) {
      this.start(selected.syncGenerationId, selected.job);
      return;
    }
    const dueTimes = [...this.pending.values()].map((job) => job.dueAtMs);
    if (this.foreground && this.nextForegroundPollAtMs !== null) {
      dueTimes.push(this.nextForegroundPollAtMs);
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
