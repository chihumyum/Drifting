export const SYNC_GENERATION_CYCLE_PHASES = [
  'idle',
  'preparing',
  'pulling',
  'ingesting',
  'applying',
  'publishing-blobs',
  'publishing-segments',
  'checkpointing',
] as const;

export type SyncGenerationCyclePhase = (typeof SYNC_GENERATION_CYCLE_PHASES)[number];

export interface CycleClock {
  nowMs(): number;
}

export interface DurableCycleOperations {
  /** Local durability barrier and bounded segment sealing. */
  prepare(signal: AbortSignal): Promise<void>;
  /** Materializes already-durable inbox bytes into decoded work. */
  ingest(signal: AbortSignal): Promise<void>;
  /** Applies decoded change sets and receipts atomically in the durable adapter. */
  apply(signal: AbortSignal): Promise<void>;
  /** Captures a checkpoint only when durable frontier policy permits it. */
  checkpoint(signal: AbortSignal): Promise<boolean>;
  /** Reads durable pending/gap/conflict/quarantine state after all writes commit. */
  inspectPending(signal: AbortSignal): Promise<{
    readonly hasPending: boolean;
    readonly hasGap: boolean;
    readonly hasConflict: boolean;
    readonly hasQuarantine: boolean;
  }>;
}

/** Provider methods are deliberately disjoint from durable transaction methods. */
export interface ProviderCycleOperations {
  pull(signal: AbortSignal): Promise<{ readonly objectCount: number }>;
  publishBlobs(signal: AbortSignal): Promise<{ readonly objectCount: number }>;
  publishSegments(signal: AbortSignal): Promise<{ readonly objectCount: number }>;
}

export interface SyncGenerationCycleStatus {
  readonly phase: SyncGenerationCyclePhase;
  readonly cycleNumber: number;
  readonly lastPullSuccessAtMs: number | null;
  readonly lastPublishSuccessAtMs: number | null;
  readonly lastConvergedAtMs: number | null;
  readonly lastOutcome: 'success' | 'cancelled' | 'failed' | null;
  readonly lastFailedPhase: Exclude<SyncGenerationCyclePhase, 'idle'> | null;
  readonly lastError: unknown | null;
}

export interface SyncGenerationCycleResult {
  readonly pulledObjects: number;
  readonly publishedBlobs: number;
  readonly publishedSegments: number;
  readonly checkpointCreated: boolean;
  readonly converged: boolean;
  /** A publish requires a following pull so cursor discovery observes our own objects. */
  readonly requiresRepull: boolean;
}

export interface SyncGenerationCycleLaneOptions {
  readonly syncGenerationId: string;
  readonly durable: DurableCycleOperations;
  readonly provider: ProviderCycleOperations;
  readonly clock: CycleClock;
  readonly onPhaseChange?: (phase: SyncGenerationCyclePhase) => void;
}

function assertObjectCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export class SyncGenerationCycleLane {
  readonly syncGenerationId: string;

  private readonly durable: DurableCycleOperations;
  private readonly provider: ProviderCycleOperations;
  private readonly clock: CycleClock;
  private readonly onPhaseChange?: (phase: SyncGenerationCyclePhase) => void;
  private active = false;
  private current: SyncGenerationCycleStatus = Object.freeze({
    phase: 'idle',
    cycleNumber: 0,
    lastPullSuccessAtMs: null,
    lastPublishSuccessAtMs: null,
    lastConvergedAtMs: null,
    lastOutcome: null,
    lastFailedPhase: null,
    lastError: null,
  });

  constructor(options: SyncGenerationCycleLaneOptions) {
    if (!options.syncGenerationId) throw new TypeError('syncGenerationId must not be empty');
    this.syncGenerationId = options.syncGenerationId;
    this.durable = options.durable;
    this.provider = options.provider;
    this.clock = options.clock;
    this.onPhaseChange = options.onPhaseChange;
  }

  get status(): SyncGenerationCycleStatus {
    return this.current;
  }

  async run(signal: AbortSignal): Promise<SyncGenerationCycleResult> {
    if (this.active) throw new Error(`SyncGeneration ${this.syncGenerationId} already has an active sync cycle`);
    this.active = true;
    this.current = Object.freeze({
      ...this.current,
      cycleNumber: this.current.cycleNumber + 1,
      lastFailedPhase: null,
      lastError: null,
    });

    try {
      this.transition('preparing');
      this.throwIfAborted(signal);
      await this.durable.prepare(signal);

      this.transition('pulling');
      this.throwIfAborted(signal);
      const pulled = await this.provider.pull(signal);
      assertObjectCount(pulled.objectCount, 'pulled objectCount');
      this.current = Object.freeze({ ...this.current, lastPullSuccessAtMs: this.clock.nowMs() });

      this.transition('ingesting');
      this.throwIfAborted(signal);
      await this.durable.ingest(signal);

      this.transition('applying');
      this.throwIfAborted(signal);
      await this.durable.apply(signal);

      this.transition('publishing-blobs');
      this.throwIfAborted(signal);
      const blobs = await this.provider.publishBlobs(signal);
      assertObjectCount(blobs.objectCount, 'published blob objectCount');

      this.transition('publishing-segments');
      this.throwIfAborted(signal);
      const segments = await this.provider.publishSegments(signal);
      assertObjectCount(segments.objectCount, 'published segment objectCount');
      this.current = Object.freeze({ ...this.current, lastPublishSuccessAtMs: this.clock.nowMs() });

      this.transition('checkpointing');
      this.throwIfAborted(signal);
      const checkpointCreated = await this.durable.checkpoint(signal);
      const pending = await this.durable.inspectPending(signal);
      const converged =
        !pending.hasPending &&
        !pending.hasGap &&
        !pending.hasConflict &&
        !pending.hasQuarantine;
      this.current = Object.freeze({
        ...this.current,
        ...(converged ? { lastConvergedAtMs: this.clock.nowMs() } : {}),
        lastOutcome: 'success',
      });
      return Object.freeze({
        pulledObjects: pulled.objectCount,
        publishedBlobs: blobs.objectCount,
        publishedSegments: segments.objectCount,
        checkpointCreated,
        converged,
        requiresRepull: blobs.objectCount + segments.objectCount > 0,
      });
    } catch (error) {
      const failedPhase = this.current.phase === 'idle' ? null : this.current.phase;
      this.current = Object.freeze({
        ...this.current,
        lastOutcome: signal.aborted ? 'cancelled' : 'failed',
        lastFailedPhase: failedPhase,
        lastError: error,
      });
      throw error;
    } finally {
      this.active = false;
      this.transition('idle');
    }
  }

  private transition(phase: SyncGenerationCyclePhase): void {
    this.current = Object.freeze({ ...this.current, phase });
    this.onPhaseChange?.(phase);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(`sync cycle cancelled: ${String(signal.reason ?? 'aborted')}`);
  }
}
