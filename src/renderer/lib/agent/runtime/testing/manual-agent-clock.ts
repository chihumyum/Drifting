import { abortReason, AgentRuntimeAbortError } from '../errors';
import type { AgentClock } from '../types';

export interface ManualAgentClockOptions {
  wallTimeMs?: number;
  monotonicTimeMs?: number;
}

export interface PendingAgentSleep {
  readonly dueAtMonotonicMs: number;
  readonly requestedMs: number;
}

interface SleepWaiter {
  readonly order: number;
  readonly dueAtMonotonicMs: number;
  readonly requestedMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

function requireFinite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite; received ${value}`);
  }
  return value;
}

function requireForwardDelta(name: string, value: number): number {
  requireFinite(name, value);
  if (value < 0) {
    throw new RangeError(`${name} must be greater than or equal to zero; received ${value}`);
  }
  return value;
}

/**
 * Deterministic clock for runtime tests.
 *
 * No host timers are installed. A sleep settles only when the test advances
 * monotonic time far enough. `advanceBy` advances wall and monotonic time
 * together, while the separate wall/monotonic methods allow clock-jump tests.
 */
export class ManualAgentClock implements AgentClock {
  private wallTime: number;
  private monotonicTime: number;
  private nextSleepOrder = 0;
  private sleepers: SleepWaiter[] = [];

  constructor(options: ManualAgentClockOptions = {}) {
    this.wallTime = requireFinite('wallTimeMs', options.wallTimeMs ?? 0);
    this.monotonicTime = requireFinite('monotonicTimeMs', options.monotonicTimeMs ?? 0);
  }

  wallNowMs(): number {
    return this.wallTime;
  }

  monotonicNowMs(): number {
    return this.monotonicTime;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const requestedMs = requireForwardDelta('sleep duration', ms);
    if (signal?.aborted) {
      return Promise.reject(new AgentRuntimeAbortError(abortReason(signal)));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SleepWaiter = {
        order: this.nextSleepOrder,
        dueAtMonotonicMs: this.monotonicTime + requestedMs,
        requestedMs,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      this.nextSleepOrder += 1;

      if (signal) {
        const onAbort = () => {
          if (!this.removeSleeper(waiter)) return;
          signal.removeEventListener('abort', onAbort);
          reject(new AgentRuntimeAbortError(abortReason(signal)));
        };
        Object.assign(waiter, { onAbort });
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.sleepers.push(waiter);
      this.sortSleepers();
    });
  }

  get pendingSleepCount(): number {
    return this.sleepers.length;
  }

  get pendingSleeps(): readonly PendingAgentSleep[] {
    return this.sleepers.map(({ dueAtMonotonicMs, requestedMs }) => ({
      dueAtMonotonicMs,
      requestedMs,
    }));
  }

  /** Advance wall and monotonic time by the same amount. */
  advanceBy(ms: number): void {
    const delta = requireForwardDelta('advanceBy', ms);
    this.wallTime += delta;
    this.monotonicTime += delta;
    this.settleDueSleeps();
  }

  /**
   * Advance only monotonic time. This is useful for deadline tests that should
   * not depend on a mutable system clock.
   */
  advanceMonotonicBy(ms: number): void {
    const delta = requireForwardDelta('advanceMonotonicBy', ms);
    this.monotonicTime += delta;
    this.settleDueSleeps();
  }

  /** Move wall time independently; negative jumps are deliberately supported. */
  advanceWallBy(ms: number): void {
    this.wallTime += requireFinite('advanceWallBy', ms);
  }

  setWallTimeMs(wallTimeMs: number): void {
    this.wallTime = requireFinite('wallTimeMs', wallTimeMs);
  }

  /** Advance monotonically to an absolute time and advance wall time by the delta. */
  advanceTo(monotonicTimeMs: number): void {
    const target = requireFinite('monotonicTimeMs', monotonicTimeMs);
    if (target < this.monotonicTime) {
      throw new RangeError(
        `monotonic time cannot move backwards: ${target} < ${this.monotonicTime}`,
      );
    }
    this.advanceBy(target - this.monotonicTime);
  }

  /**
   * Advance to the next pending sleep. Returns false when the clock is idle.
   * Promise continuations run in the normal microtask queue.
   */
  advanceToNext(): boolean {
    const next = this.sleepers[0];
    if (!next) return false;
    this.advanceTo(next.dueAtMonotonicMs);
    return true;
  }

  /**
   * Drain sleeps, including sleeps scheduled by an immediately resumed
   * continuation. The step bound makes accidental infinite timer loops fail
   * deterministically.
   */
  async runUntilIdle(maxSteps = 10_000): Promise<number> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new RangeError(`maxSteps must be a positive safe integer; received ${maxSteps}`);
    }

    let steps = 0;
    while (this.sleepers.length > 0) {
      if (steps >= maxSteps) {
        throw new Error(
          `ManualAgentClock did not become idle after ${maxSteps} advancement steps`,
        );
      }
      this.advanceToNext();
      steps += 1;
      await Promise.resolve();
    }
    return steps;
  }

  assertIdle(): void {
    if (this.sleepers.length === 0) return;
    const dueTimes = this.sleepers.map((sleep) => sleep.dueAtMonotonicMs).join(', ');
    throw new Error(
      `ManualAgentClock has ${this.sleepers.length} pending sleep(s), due at: ${dueTimes}`,
    );
  }

  private settleDueSleeps(): void {
    const due: SleepWaiter[] = [];
    while (
      this.sleepers.length > 0
      && this.sleepers[0].dueAtMonotonicMs <= this.monotonicTime
    ) {
      const waiter = this.sleepers.shift();
      if (waiter) due.push(waiter);
    }

    for (const waiter of due) {
      this.detachAbort(waiter);
      waiter.resolve();
    }
  }

  private removeSleeper(target: SleepWaiter): boolean {
    const index = this.sleepers.indexOf(target);
    if (index < 0) return false;
    this.sleepers.splice(index, 1);
    return true;
  }

  private detachAbort(waiter: SleepWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
  }

  private sortSleepers(): void {
    this.sleepers.sort(
      (left, right) =>
        left.dueAtMonotonicMs - right.dueAtMonotonicMs || left.order - right.order,
    );
  }
}
