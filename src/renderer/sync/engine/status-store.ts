import type { SyncGenerationCyclePhase, SyncGenerationCycleStatus } from './cycle';

export interface SyncGenerationPendingDiagnostics {
  readonly pendingChangeSets: number;
  readonly pendingSegments: number;
  readonly pendingTransfers: number;
  readonly openGaps: number;
  readonly openConflicts: number;
  readonly quarantinedObjects: number;
}

export type SyncGenerationTransferStage = 'download' | 'upload-assets' | 'upload-changes';

export interface SyncGenerationTransferProgress {
  readonly stage: SyncGenerationTransferStage;
  readonly completedObjects: number;
  readonly totalObjects: number;
  readonly transferredBytes: number;
  readonly totalBytes: number;
  /** Pull inventory can discover more objects while already transferring a page. */
  readonly totalKnown: boolean;
}

export interface SyncGenerationRuntimeStatus {
  readonly syncGenerationId: string;
  /** Project-scoped UI identity; null for legacy/test runtimes. */
  readonly projectId?: string | null;
  readonly phase: SyncGenerationCyclePhase;
  readonly cycleNumber: number;
  readonly lastPullSuccessAtMs: number | null;
  readonly lastPublishSuccessAtMs: number | null;
  readonly lastConvergedAtMs: number | null;
  readonly lastOutcome: SyncGenerationCycleStatus['lastOutcome'];
  readonly lastFailedPhase: SyncGenerationCycleStatus['lastFailedPhase'];
  readonly lastErrorCode: string | null;
  readonly transferProgress: SyncGenerationTransferProgress | null;
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

  updateCycle(
    syncGenerationId: string,
    status: SyncGenerationCycleStatus,
    projectId?: string,
    transferProgress: SyncGenerationTransferProgress | null = null,
  ): void {
    const previous = this.statuses.get(syncGenerationId);
    this.statuses.set(syncGenerationId, Object.freeze({
      syncGenerationId,
      projectId: projectId ?? previous?.projectId ?? null,
      phase: status.phase,
      cycleNumber: status.cycleNumber,
      lastPullSuccessAtMs: status.lastPullSuccessAtMs,
      lastPublishSuccessAtMs: status.lastPublishSuccessAtMs,
      lastConvergedAtMs: status.lastConvergedAtMs,
      lastOutcome: status.lastOutcome,
      lastFailedPhase: status.lastFailedPhase,
      lastErrorCode: errorCode(status.lastError),
      transferProgress: transferProgress ? Object.freeze({ ...transferProgress }) : null,
      pending: previous?.pending ?? emptyPending,
    }));
    this.emit();
  }

  updatePending(
    syncGenerationId: string,
    pending: SyncGenerationPendingDiagnostics,
    projectId?: string,
  ): void {
    const previous = this.statuses.get(syncGenerationId);
    this.statuses.set(syncGenerationId, Object.freeze({
      syncGenerationId,
      projectId: projectId ?? previous?.projectId ?? null,
      phase: previous?.phase ?? 'idle',
      cycleNumber: previous?.cycleNumber ?? 0,
      lastPullSuccessAtMs: previous?.lastPullSuccessAtMs ?? null,
      lastPublishSuccessAtMs: previous?.lastPublishSuccessAtMs ?? null,
      lastConvergedAtMs: previous?.lastConvergedAtMs ?? null,
      lastOutcome: previous?.lastOutcome ?? null,
      lastFailedPhase: previous?.lastFailedPhase ?? null,
      lastErrorCode: previous?.lastErrorCode ?? null,
      transferProgress: previous?.transferProgress ?? null,
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
          .map((status) => Object.freeze({
            ...status,
            transferProgress: status.transferProgress
              ? Object.freeze({ ...status.transferProgress })
              : null,
            pending: Object.freeze({ ...status.pending }),
          })),
      ),
    });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
