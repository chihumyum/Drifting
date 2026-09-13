export interface CopilotInvocation {
  signal: AbortSignal;
  isCurrent(): boolean;
  finish(): void;
}

/** One mounted editor capability runner, including work awaiting its context. */
export class CopilotInvocationOwner {
  private disposed = false;
  private readonly active = new Map<unknown, AbortController>();
  constructor(private readonly available: () => boolean) {}

  has(key: unknown): boolean { return this.active.has(key); }
  canStart(): boolean { return !this.disposed && this.available(); }

  begin(key: unknown): CopilotInvocation | null {
    if (!this.canStart()) return null;
    const previous = this.active.get(key);
    const controller = new AbortController();
    this.active.set(key, controller);
    previous?.abort();
    return {
      signal: controller.signal,
      isCurrent: () => !this.disposed && this.available() && !controller.signal.aborted && this.active.get(key) === controller,
      finish: () => { if (this.active.get(key) === controller) this.active.delete(key); },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
  }
}
