import type {
  SyncEngineDiagnostics,
  SyncGenerationCyclePhase,
  SyncGenerationRuntimeStatus,
  SyncGenerationTransferProgress,
} from './engine';

/**
 * What the paper's corner and the notification bell say about Hosted sync
 * (docs/hosted-sync/sync-status.md). Light states (a long transfer, a retry,
 * being offline) only show on the paper; problems the author has to act on
 * also reach the bell.
 *
 * The runtime snapshot only knows each SyncGeneration's latest cycle, so this
 * tracker remembers what the thresholds need across snapshots: how long the
 * current run of cycles has been busy, and how many cycles in a row failed.
 */

/** A run of cycles shorter than this never shows the cloud. */
export const SYNC_MARK_SHOW_AFTER_MS = 3_000;
/** The cloud stays this long after the last busy cycle, bridging back-to-back rounds. */
export const SYNC_MARK_LINGER_MS = 1_500;
/** A failure the scheduler has been retrying this long shows as retrying. */
export const SYNC_RETRY_SHOW_AFTER_MS = 30_000;
/** This many failed cycles in a row, or failing this long, is a problem. */
export const SYNC_FAILING_CYCLES = 3;
export const SYNC_FAILING_FOR_MS = 5 * 60_000;

export const SYNC_QUOTA_ERROR_CODE = 'QUOTA_EXCEEDED';

export type SyncSessionStatus = 'signed-out' | 'checking' | 'connected' | 'offline' | 'needs-reauth';

/** A problem the author has to act on: shown on the paper and on the bell until resolved. */
export type SyncProblem = 'not-started' | 'reauth' | 'quota' | 'failing';

export interface SyncHealthInput {
  /** The sync authority has been read; before that nothing is known yet. */
  readonly loaded: boolean;
  /** The library syncs with Hosted (authority mode). */
  readonly hosted: boolean;
  /** The author paused automatic sync. */
  readonly paused: boolean;
  readonly session: SyncSessionStatus;
  readonly activationFailed: boolean;
  readonly diagnostics: SyncEngineDiagnostics | null;
}

export interface SyncTransferView {
  readonly phase: SyncGenerationCyclePhase;
  readonly progress: SyncGenerationTransferProgress | null;
}

export interface SyncGenerationHealth {
  readonly syncGenerationId: string;
  readonly projectId: string | null;
  /** Busy past SYNC_MARK_SHOW_AFTER_MS, or within the linger after it. */
  readonly syncing: boolean;
  /** What the busy cycle is doing; the last transfer while lingering. */
  readonly transfer: SyncTransferView | null;
  readonly retrying: boolean;
  readonly problem: Extract<SyncProblem, 'quota' | 'failing'> | null;
  readonly failures: number;
  readonly errorCode: string | null;
  readonly pendingChanges: number;
}

export interface SyncHealthSnapshot {
  /** False until the sync authority has been read: no answer yet, not "no problems". */
  readonly observed: boolean;
  readonly hosted: boolean;
  readonly paused: boolean;
  readonly offline: boolean;
  /** A problem that stops every book, not one SyncGeneration. */
  readonly globalProblem: Extract<SyncProblem, 'not-started' | 'reauth'> | null;
  readonly generations: readonly SyncGenerationHealth[];
}

export const EMPTY_SYNC_HEALTH: SyncHealthSnapshot = Object.freeze({
  observed: false,
  hosted: false,
  paused: false,
  offline: false,
  globalProblem: null,
  generations: Object.freeze([]),
});

const LOCAL_SYNC_HEALTH: SyncHealthSnapshot = Object.freeze({ ...EMPTY_SYNC_HEALTH, observed: true });

interface GenerationMemory {
  /** The last cycle whose outcome was counted. */
  countedCycle: number;
  failures: number;
  failingSinceMs: number | null;
  /** Start of the current busy run, gaps shorter than the linger included. */
  busySinceMs: number | null;
  /** When the busy run last went idle; null while busy. */
  idleSinceMs: number | null;
  lastTransfer: SyncTransferView | null;
}

/**
 * Remembers each SyncGeneration across runtime snapshots. Call `observe` on
 * every snapshot and `evaluate` whenever the answer may have changed; the
 * evaluation says when it will next change on its own (`wakeAtMs`).
 */
export class SyncHealthTracker {
  private readonly memory = new Map<string, GenerationMemory>();
  private input: SyncHealthInput = {
    loaded: false,
    hosted: false,
    paused: false,
    session: 'signed-out',
    activationFailed: false,
    diagnostics: null,
  };

  observe(input: SyncHealthInput, nowMs: number): void {
    this.input = input;
    const generations = input.diagnostics?.generations ?? [];
    const seen = new Set<string>();
    for (const generation of generations) {
      seen.add(generation.syncGenerationId);
      this.observeGeneration(generation, nowMs);
    }
    for (const id of [...this.memory.keys()]) {
      if (!seen.has(id)) this.memory.delete(id);
    }
  }

  evaluate(nowMs: number): { readonly health: SyncHealthSnapshot; readonly wakeAtMs: number | null } {
    const input = this.input;
    if (!input.loaded) return { health: EMPTY_SYNC_HEALTH, wakeAtMs: null };
    if (!input.hosted) return { health: LOCAL_SYNC_HEALTH, wakeAtMs: null };
    let wakeAtMs: number | null = null;
    const wake = (atMs: number) => {
      if (atMs > nowMs && (wakeAtMs === null || atMs < wakeAtMs)) wakeAtMs = atMs;
    };

    const generations: SyncGenerationHealth[] = [];
    for (const status of input.diagnostics?.generations ?? []) {
      const memory = this.memory.get(status.syncGenerationId);
      if (!memory) continue;

      let syncing = false;
      if (memory.busySinceMs !== null) {
        const busyUntil = memory.idleSinceMs ?? nowMs;
        const shownAt = memory.busySinceMs + SYNC_MARK_SHOW_AFTER_MS;
        if (busyUntil >= shownAt) {
          if (memory.idleSinceMs === null) syncing = true;
          else {
            syncing = nowMs < memory.idleSinceMs + SYNC_MARK_LINGER_MS;
            if (syncing) wake(memory.idleSinceMs + SYNC_MARK_LINGER_MS);
          }
        } else if (memory.idleSinceMs === null) {
          wake(shownAt);
        }
      }

      const failingFor = memory.failingSinceMs === null ? 0 : nowMs - memory.failingSinceMs;
      const quota = memory.failures > 0 && status.lastErrorCode === SYNC_QUOTA_ERROR_CODE;
      const failing =
        memory.failures >= SYNC_FAILING_CYCLES ||
        (memory.failingSinceMs !== null && failingFor >= SYNC_FAILING_FOR_MS);
      if (memory.failingSinceMs !== null) {
        wake(memory.failingSinceMs + SYNC_RETRY_SHOW_AFTER_MS);
        wake(memory.failingSinceMs + SYNC_FAILING_FOR_MS);
      }
      const problem = quota ? 'quota' : failing ? 'failing' : null;

      generations.push(Object.freeze({
        syncGenerationId: status.syncGenerationId,
        projectId: status.projectId ?? null,
        syncing,
        transfer:
          status.phase !== 'idle'
            ? { phase: status.phase, progress: status.transferProgress }
            : memory.lastTransfer,
        retrying: problem === null && memory.failingSinceMs !== null && failingFor >= SYNC_RETRY_SHOW_AFTER_MS,
        problem,
        failures: memory.failures,
        errorCode: memory.failures > 0 ? status.lastErrorCode : null,
        pendingChanges: status.pending.pendingChangeSets,
      }));
    }

    const health: SyncHealthSnapshot = Object.freeze({
      observed: true,
      hosted: true,
      paused: input.paused,
      offline: input.session === 'offline' || input.diagnostics?.online === false,
      globalProblem:
        input.session === 'needs-reauth' ? 'reauth' : input.activationFailed ? 'not-started' : null,
      generations: Object.freeze(generations),
    });
    return { health, wakeAtMs };
  }

  private observeGeneration(status: SyncGenerationRuntimeStatus, nowMs: number): void {
    let memory = this.memory.get(status.syncGenerationId);
    if (!memory) {
      memory = {
        countedCycle: status.phase === 'idle' ? status.cycleNumber : status.cycleNumber - 1,
        failures: status.phase === 'idle' && status.lastOutcome === 'failed' ? 1 : 0,
        failingSinceMs: status.phase === 'idle' && status.lastOutcome === 'failed' ? nowMs : null,
        busySinceMs: null,
        idleSinceMs: null,
        lastTransfer: null,
      };
      this.memory.set(status.syncGenerationId, memory);
    }

    if (status.phase !== 'idle') {
      const resumed =
        memory.busySinceMs !== null &&
        (memory.idleSinceMs === null || nowMs - memory.idleSinceMs < SYNC_MARK_LINGER_MS);
      if (!resumed) memory.busySinceMs = nowMs;
      memory.idleSinceMs = null;
      if (status.transferProgress) {
        memory.lastTransfer = { phase: status.phase, progress: status.transferProgress };
      } else if (!memory.lastTransfer?.progress) {
        memory.lastTransfer = { phase: status.phase, progress: null };
      }
      return;
    }

    if (memory.busySinceMs !== null) {
      if (memory.idleSinceMs === null) memory.idleSinceMs = nowMs;
      else if (nowMs - memory.idleSinceMs >= SYNC_MARK_LINGER_MS) {
        memory.busySinceMs = null;
        memory.idleSinceMs = null;
        memory.lastTransfer = null;
      }
    }

    if (status.cycleNumber > memory.countedCycle && status.lastOutcome !== null) {
      memory.countedCycle = status.cycleNumber;
      if (status.lastOutcome === 'failed') {
        memory.failures += 1;
        memory.failingSinceMs ??= nowMs;
      } else if (status.lastOutcome === 'success') {
        memory.failures = 0;
        memory.failingSinceMs = null;
      }
    }
  }
}

export type SyncCornerState =
  | { readonly kind: 'none' }
  | { readonly kind: 'syncing'; readonly transfer: SyncTransferView | null }
  | { readonly kind: 'retrying'; readonly syncGenerationIds: readonly string[] }
  | { readonly kind: 'offline'; readonly pendingChanges: number }
  | {
      readonly kind: 'problem';
      readonly problem: SyncProblem;
      readonly errorCode: string | null;
      readonly failures: number;
      readonly syncGenerationIds: readonly string[];
    };

const NONE: SyncCornerState = Object.freeze({ kind: 'none' });

/** What the paper's corner shows for one book. A problem wins over offline, retrying and syncing. */
export function syncCornerFor(health: SyncHealthSnapshot, projectId: string | null): SyncCornerState {
  if (!health.hosted || !projectId) return NONE;
  return cornerOf(health, health.generations.filter((generation) => generation.projectId === projectId));
}

/** The whole library's state, as the shelf's account cell says it: every book together. */
export function syncLibraryCornerFor(health: SyncHealthSnapshot): SyncCornerState {
  if (!health.hosted) return NONE;
  return cornerOf(health, health.generations);
}

function cornerOf(health: SyncHealthSnapshot, own: SyncHealthSnapshot['generations']): SyncCornerState {
  if (health.globalProblem) {
    return { kind: 'problem', problem: health.globalProblem, errorCode: null, failures: 0, syncGenerationIds: [] };
  }
  if (health.paused) return NONE;
  const problem = own.find((generation) => generation.problem === 'quota') ?? own.find((generation) => generation.problem);
  if (problem?.problem) {
    return {
      kind: 'problem',
      problem: problem.problem,
      errorCode: problem.errorCode,
      failures: problem.failures,
      syncGenerationIds: own.filter((generation) => generation.problem).map((generation) => generation.syncGenerationId),
    };
  }
  if (health.offline) {
    return { kind: 'offline', pendingChanges: own.reduce((sum, generation) => sum + generation.pendingChanges, 0) };
  }
  const retrying = own.filter((generation) => generation.retrying);
  if (retrying.length > 0) {
    return { kind: 'retrying', syncGenerationIds: retrying.map((generation) => generation.syncGenerationId) };
  }
  const syncing = own.filter((generation) => generation.syncing);
  if (syncing.length > 0) {
    const transferring = syncing.find((generation) => generation.transfer?.progress) ?? syncing[0]!;
    return { kind: 'syncing', transfer: transferring.transfer };
  }
  return NONE;
}

export interface SyncProblemReport {
  readonly problem: SyncProblem;
  /** Null for a problem that stops every book. */
  readonly projectId: string | null;
  readonly syncGenerationIds: readonly string[];
  readonly errorCode: string | null;
  readonly failures: number;
}

/** Problems for the bell: every book's, not only the open one. */
export function syncProblemsOf(health: SyncHealthSnapshot): readonly SyncProblemReport[] {
  if (!health.hosted) return [];
  if (health.globalProblem) {
    return [{ problem: health.globalProblem, projectId: null, syncGenerationIds: [], errorCode: null, failures: 0 }];
  }
  const byProject = new Map<string | null, SyncProblemReport>();
  for (const generation of health.generations) {
    if (!generation.problem) continue;
    const current = byProject.get(generation.projectId);
    if (current && (current.problem === 'quota' || generation.problem !== 'quota')) {
      byProject.set(generation.projectId, {
        ...current,
        syncGenerationIds: [...current.syncGenerationIds, generation.syncGenerationId],
      });
      continue;
    }
    byProject.set(generation.projectId, {
      problem: generation.problem,
      projectId: generation.projectId,
      syncGenerationIds: [...(current?.syncGenerationIds ?? []), generation.syncGenerationId],
      errorCode: generation.errorCode,
      failures: generation.failures,
    });
  }
  return [...byProject.values()];
}
