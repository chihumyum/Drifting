import type { SyncEngineCoordinator, SyncEngineDiagnostics } from './engine';
import { events } from '../lib/events';

export interface ProductSyncRuntimeSnapshot {
  readonly mounted: boolean;
  readonly syncGenerationIds: readonly string[];
  readonly diagnostics: SyncEngineDiagnostics | null;
}

export interface ProductSyncConvergenceOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

type Listener = () => void;

const EMPTY_SNAPSHOT: ProductSyncRuntimeSnapshot = Object.freeze({
  mounted: false,
  syncGenerationIds: Object.freeze([]),
  diagnostics: null,
});

/**
 * Sanitized App-facing bridge to the single production coordinator.
 *
 * It deliberately exposes no provider binding, token, path, content, transfer
 * session or reducer payload. Settings and status UI can observe counters and
 * request a manual cycle without gaining access to the transport itself.
 */
export class ProductSyncRuntimeControl {
  private coordinator: SyncEngineCoordinator | null = null;
  private unsubscribeStatus: () => void = () => {};
  private readonly listeners = new Set<Listener>();
  private snapshot: ProductSyncRuntimeSnapshot = EMPTY_SNAPSHOT;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ProductSyncRuntimeSnapshot {
    return this.snapshot;
  }

  attach(coordinator: SyncEngineCoordinator): () => void {
    if (this.coordinator && this.coordinator !== coordinator) {
      throw new Error('A production SyncEngine coordinator is already exposed');
    }
    this.coordinator = coordinator;
    this.unsubscribeStatus();
    this.unsubscribeStatus = coordinator.statusStore.subscribe(() => {
      this.refresh();
      events.emit('sync:runtime-state-changed');
    });
    this.refresh();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.coordinator !== coordinator) return;
      this.unsubscribeStatus();
      this.unsubscribeStatus = () => {};
      this.coordinator = null;
      this.snapshot = EMPTY_SNAPSHOT;
      this.emit();
    };
  }

  triggerManual(syncGenerationId?: string): void {
    const coordinator = this.coordinator;
    if (!coordinator) throw new Error('Cloud SyncEngine is not active');
    if (syncGenerationId) {
      coordinator.triggerManual(syncGenerationId);
      return;
    }
    const syncGenerationIds = coordinator.registeredSyncGenerationIds();
    if (syncGenerationIds.length === 0) throw new Error('No cloud SyncGeneration is active');
    for (const id of syncGenerationIds) coordinator.triggerManual(id);
  }

  /**
   * Run a fresh cycle for every mounted SyncGeneration and resolve only after that cycle
   * (including any self-publish repull) reports a clean durable frontier.
   */
  waitForConvergence(options: ProductSyncConvergenceOptions = {}): Promise<void> {
    const coordinator = this.coordinator;
    if (!coordinator) return Promise.reject(new Error('Cloud SyncEngine is not active'));
    const before = coordinator.diagnostics();
    if (!before.online || before.suspended) {
      return Promise.reject(new Error('Cloud SyncEngine is offline or suspended'));
    }
    const syncGenerationIds = coordinator.registeredSyncGenerationIds();
    if (syncGenerationIds.length === 0) return Promise.reject(new Error('No cloud SyncGeneration is active'));
    const priorCycles = new Map(
      before.generations.map((generation) => [generation.syncGenerationId, generation.cycleNumber]),
    );
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError('Sync convergence timeout must be a positive integer'));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        unsubscribe();
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const inspect = () => {
        const diagnostics = coordinator.diagnostics();
        for (const syncGenerationId of syncGenerationIds) {
          const generation = diagnostics.generations.find((candidate) => candidate.syncGenerationId === syncGenerationId);
          if (!generation || generation.cycleNumber <= (priorCycles.get(syncGenerationId) ?? 0)) return;
          if (generation.phase !== 'idle') return;
          if (generation.lastOutcome === 'failed') {
            finish(new Error(generation.lastErrorCode ?? 'Cloud sync cycle failed'));
            return;
          }
          if (
            generation.lastOutcome !== 'success' ||
            generation.pending.pendingChangeSets > 0 ||
            generation.pending.pendingSegments > 0 ||
            generation.pending.pendingTransfers > 0 ||
            generation.pending.openGaps > 0 ||
            generation.pending.openConflicts > 0 ||
            generation.pending.quarantinedObjects > 0
          ) {
            return;
          }
        }
        finish();
      };
      const onAbort = () =>
        finish(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new DOMException('Sync convergence cancelled', 'AbortError'),
        );
      const unsubscribe = coordinator.statusStore.subscribe(inspect);
      const timer = globalThis.setTimeout(
        () => finish(new Error('Timed out waiting for cloud sync convergence')),
        timeoutMs,
      );
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      for (const syncGenerationId of syncGenerationIds) coordinator.triggerManual(syncGenerationId);
      inspect();
    });
  }

  private refresh(): void {
    const coordinator = this.coordinator;
    this.snapshot = coordinator
      ? Object.freeze({
          mounted: true,
          syncGenerationIds: coordinator.registeredSyncGenerationIds(),
          diagnostics: coordinator.diagnostics(),
        })
      : EMPTY_SNAPSHOT;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const productSyncRuntimeControl = new ProductSyncRuntimeControl();
