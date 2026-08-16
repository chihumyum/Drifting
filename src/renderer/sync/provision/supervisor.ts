export interface SyncGenerationProvisionSupervisorDependencies {
  /** Runs one full pending inventory serially and returns after durable outcomes. */
  readonly runOnce: (signal: AbortSignal) => Promise<void>;
  readonly canUseProvider: () => boolean;
  readonly onError: (error: unknown) => void;
  readonly random?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const handle = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(handle);
}

/** Single-flight, restart-safe foreground supervisor for pending SyncGeneration genesis. */
export class SyncGenerationProvisionSupervisor {
  private tail: Promise<void> = Promise.resolve();
  private running = false;
  private queued = false;
  private stopped = false;
  private failureCount = 0;
  private controller: AbortController | null = null;
  private cancelRetry: () => void = () => {};

  constructor(private readonly dependencies: SyncGenerationProvisionSupervisorDependencies) {}

  requestRun(): void {
    if (this.stopped) return;
    this.queued = true;
    this.cancelRetry();
    this.cancelRetry = () => {};
    if (this.running) return;
    this.running = true;
    this.tail = this.tail
      .catch(() => undefined)
      .then(() => this.drainQueue())
      .finally(() => {
        this.running = false;
        if (this.queued && !this.stopped) this.requestRun();
      });
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  deactivate(): void {
    this.queued = false;
    this.controller?.abort(new DOMException('SyncGeneration provisioning deactivated', 'AbortError'));
    this.controller = null;
    this.cancelRetry();
    this.cancelRetry = () => {};
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.deactivate();
  }

  private async drainQueue(): Promise<void> {
    while (this.queued && !this.stopped) {
      this.queued = false;
      if (!this.dependencies.canUseProvider()) return;
      const controller = new AbortController();
      this.controller = controller;
      try {
        await this.dependencies.runOnce(controller.signal);
        this.failureCount = 0;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.failureCount += 1;
          this.dependencies.onError(error);
          this.scheduleRetry();
        }
        return;
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const cap = Math.min(300_000, 1_000 * 2 ** Math.min(this.failureCount - 1, 18));
    const random = Math.max(0, Math.min(1, (this.dependencies.random ?? Math.random)()));
    const delayMs = Math.floor(cap * random);
    this.cancelRetry();
    this.cancelRetry = (this.dependencies.schedule ?? defaultSchedule)(
      () => {
        this.cancelRetry = () => {};
        this.requestRun();
      },
      delayMs,
    );
  }
}
