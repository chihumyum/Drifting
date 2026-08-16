import type { SyncGenerationCyclePhase, SyncGenerationCycleStatus } from './cycle';

export interface SyncGenerationPendingDiagnostics {
  readonly pendingChangeSets: number;
  readonly pendingSegments: number;
  readonly pendingTransfers: number;
  readonly openGaps: number;
  readonly openConflicts: number;
  readonly quarantinedObjects: number;
}

export interface SyncGenerationRuntimeStatus {
  readonly syncGenerationId: string;
  readonly phase: SyncGenerationCyclePhase;
  readonly cycleNumber: number;
  readonly lastPullSuccessAtMs: number | null;
  readonly lastPublishSuccessAtMs: number | null;
  readonly lastConvergedAtMs: number | null;
  readonly lastOutcome: SyncGenerationCycleStatus['lastOutcome'];
  readonly lastFailedPhase: SyncGenerationCycleStatus['lastFailedPhase'];
  readonly lastErrorCode: string | null;
  readonly pending: SyncGenerationPendingDiagnostics;
}

export interface SyncEngineDiagnostics {
  readonly generatedAtMs: number;
  readonly activeSyncGenerationId: string | null;
  readonly online: boolean;
  readonly suspended: boolean;
  readonly generations: readonly SyncGenerationRuntimeStatus[];
}

type Listener = () => void;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return error === null ? null : 'SYNC_CYCLE_FAILED';
  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === 'string' && candidate.code.length <= 128) return candidate.code;
  if (typeof candidate.name === 'string' && candidate.name.length <= 128) return candidate.name;
  return 'SYNC_CYCLE_FAILED';
}

const emptyPending: SyncGenerationPendingDiagnostics = Object.freeze({
  pendingChangeSets: 0,
  pendingSegments: 0,
  pendingTransfers: 0,
  openGaps: 0,
  openConflicts: 0,
  quarantinedObjects: 0,
});

export class SyncEngineStatusStore {
  private readonly statuses = new Map<string, SyncGenerationRuntimeStatus>();
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  remove(syncGenerationId: string): void {
    if (!this.statuses.delete(syncGenerationId)) return;
    this.emit();
  }

  updateCycle(syncGenerationId: string, status: SyncGenerationCycleStatus): void {
    const previous = this.statuses.get(syncGenerationId);
    this.statuses.set(syncGenerationId, Object.freeze({
      syncGenerationId,
      phase: status.phase,
      cycleNumber: status.cycleNumber,
      lastPullSuccessAtMs: status.lastPullSuccessAtMs,
      lastPublishSuccessAtMs: status.lastPublishSuccessAtMs,
      lastConvergedAtMs: status.lastConvergedAtMs,
      lastOutcome: status.lastOutcome,
      lastFailedPhase: status.lastFailedPhase,
      lastErrorCode: errorCode(status.lastError),
      pending: previous?.pending ?? emptyPending,
    }));
    this.emit();
  }

  updatePending(syncGenerationId: string, pending: SyncGenerationPendingDiagnostics): void {
    const previous = this.statuses.get(syncGenerationId);
    this.statuses.set(syncGenerationId, Object.freeze({
      syncGenerationId,
      phase: previous?.phase ?? 'idle',
      cycleNumber: previous?.cycleNumber ?? 0,
      lastPullSuccessAtMs: previous?.lastPullSuccessAtMs ?? null,
      lastPublishSuccessAtMs: previous?.lastPublishSuccessAtMs ?? null,
      lastConvergedAtMs: previous?.lastConvergedAtMs ?? null,
      lastOutcome: previous?.lastOutcome ?? null,
      lastFailedPhase: previous?.lastFailedPhase ?? null,
      lastErrorCode: previous?.lastErrorCode ?? null,
      pending: Object.freeze({ ...pending }),
    }));
    this.emit();
  }

  getSyncGeneration(syncGenerationId: string): SyncGenerationRuntimeStatus | null {
    return this.statuses.get(syncGenerationId) ?? null;
  }

  diagnostics(input: {
    nowMs: number;
    activeSyncGenerationId: string | null;
    online: boolean;
    suspended: boolean;
  }): SyncEngineDiagnostics {
    return Object.freeze({
      generatedAtMs: input.nowMs,
      activeSyncGenerationId: input.activeSyncGenerationId,
      online: input.online,
      suspended: input.suspended,
      generations: Object.freeze(
        [...this.statuses.values()]
          .sort((left, right) => left.syncGenerationId < right.syncGenerationId ? -1 : left.syncGenerationId > right.syncGenerationId ? 1 : 0)
          .map((status) => Object.freeze({ ...status, pending: Object.freeze({ ...status.pending }) })),
      ),
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
