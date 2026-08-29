import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import type { DbClient, DbTransaction } from '../../lib/db';
import {
  SyncBlobStateTable,
  SyncChangeSetTable,
  SyncConflictTable,
  SyncFrontierGapTable,
  SyncLocalObjectTable,
  SyncMutationTable,
  SyncProviderBindingTable,
  SyncQuarantinedObjectTable,
  SyncRemoteObjectTable,
  SyncSegmentTable,
  SyncTransferTable,
  SyncGenerationTable,
  SyncGenerationWriterStateTable,
} from '../../schema/drizzle';
import type { SyncWriterIdentitySource } from '../journal';
import {
  applyVerifiedRemoteChangeSetInTransaction,
  type ReducerEffect,
  type SyncDomainMaterializationKernel,
  SyncReducerRejectedError,
} from '../reducer';
import {
  beginInventory,
  commitDurableChangePage,
  commitDurableInventoryPage,
  createDurableCursorState,
  currentChangePageRequest,
  currentInventoryPageToken,
  resetCursorForFullInventory,
  type DurablePageReceipt,
} from './cursor';
import {
  decodeCanonicalCbor,
  decodeSyncChangeSetV1,
  decodeSegmentV1,
  encodeCanonicalCbor,
  createLocalObjectRef,
  compareUtf8Bytewise,
  sha256Bytes,
  parseProjectAssetMutationV1,
  validateProjectAssetBindSemantics,
  type LocalObjectRef,
  type ObjectLogProvider,
  type ProviderBinding,
  type ProviderKind,
  type ProviderObjectId,
  type ProviderGeneration,
  type RemoteObject,
  type RemoteObjectChange,
  type SegmentV1,
  type Sha256,
  type SyncObjectKind,
} from '../protocol';
import {
  canAdvanceContiguousFrontier,
  contiguousFrontierSeq,
  isFrontierRangeComplete,
  observeFrontierRange,
  setAppliedSegmentHead,
} from './frontier';
import type { SyncEngineObjectCodec } from './object-codec';
import type { SyncAssetBlobDeclaration, SyncEngineBlobPort } from './blob-port';
import {
  persistWriterFrontierInTransaction,
  SqliteSyncEngineStateRepository,
} from './sqlite-repository';
import {
  ChangeSetSegmenter,
  type SealedSegment,
  type SegmentFlushReason,
} from './segmenter';
import type { SchedulerTrigger } from './scheduler';
import { createProviderTransferId } from './transfer-id';
import type { SyncGenerationPendingDiagnostics } from './status-store';
import { SyncGenerationCycleLane, type CycleClock, type SyncGenerationCycleResult } from './cycle';

const MAX_PROVIDER_PAGES_PER_CYCLE = 10_000;
const MAX_INVALID_TOKEN_RECOVERIES_PER_CYCLE = 1;

/** Cursor ownership must change whenever provider authority or binding identity changes. */
export function syncProviderEpoch(providerKind: ProviderKind, binding: ProviderBinding): string {
  return `${providerKind}:${binding.authorityGeneration}:${binding.bindingId}`;
}

export interface SyncEngineRuntimeClock extends CycleClock {
  nowIso(): string;
}

export type RemoteProjectChangeProjectionImpact = 'prose-only' | 'workspace';

/**
 * Pure Yjs materialization is delivered directly into every open editor before
 * the product callback runs. It therefore does not require replacing the
 * renderer's structural workspace projection. Empty/no-op and mixed batches
 * stay conservative so only proven prose-only commits can bypass the barrier.
 */
export function remoteProjectChangeProjectionImpact(
  effects: readonly ReducerEffect[],
): RemoteProjectChangeProjectionImpact {
  const materialized = effects.filter((effect) => effect.materialize);
  return materialized.length > 0 &&
    materialized.every((effect) => effect.type === 'yjs.update')
    ? 'prose-only'
    : 'workspace';
}

export interface SyncEngineCheckpointHook {
  captureIfDue(input: {
    syncGenerationId: string;
    signal: AbortSignal;
  }): Promise<boolean>;
}

export interface SqliteSyncGenerationRuntimeOptions {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly projectId?: string;
  readonly provider: ObjectLogProvider;
  readonly providerBinding: ProviderBinding;
  readonly objectCodec: SyncEngineObjectCodec;
  readonly blobPort?: SyncEngineBlobPort;
  readonly writerIdentity: SyncWriterIdentitySource;
  readonly domainKernel: SyncDomainMaterializationKernel;
  readonly clock?: SyncEngineRuntimeClock;
  readonly flushLocalDurability?: () => Promise<void>;
  readonly checkpoint?: SyncEngineCheckpointHook;
  /**
   * Renderer-only post-commit bridge for already-open Yjs sessions. Omitting
   * docIds reconciles every open document in the project, which makes a prior
   * callback failure/crash replayable on the next cycle even though the remote
   * apply receipt and frontier are already durable.
   */
  readonly reconcileOpenYjsDocuments?: (input: {
    readonly projectId: string;
    readonly docIds?: readonly string[];
  }) => Promise<void>;
  /** Fired after the reducer commit and any exact live-Yjs reconciliation. */
  readonly onRemoteChangeCommitted?: (input: {
    readonly projectId: string;
    readonly changeSetId: string;
    readonly projectionImpact: RemoteProjectChangeProjectionImpact;
  }) => void;
  readonly onStatus?: (runtime: SqliteSyncGenerationRuntime) => void;
}

interface SyncGenerationIdentity {
  readonly projectId: string;
  readonly projectSyncId: string;
  readonly syncGenerationId: string;
}

interface DurableDownload {
  readonly remoteId: string;
  readonly localObjectId: string;
  readonly destinationRef: LocalObjectRef;
  readonly transferId: string;
  readonly downloadRequired: boolean;
  readonly quarantineCollision: boolean;
}

interface DownloadedSegmentRow {
  readonly remoteId: string;
  readonly providerObjectId: string;
  readonly logicalKeyId: string;
  readonly storedSha256: string;
  readonly sizeBytes: number;
  readonly localObjectId: string;
  readonly storageRef: string;
}

interface PublishableLocalObject {
  readonly localObjectId: string;
  readonly objectKind: SyncObjectKind;
  readonly logicalKeyId: string;
  readonly storageRef: string;
  readonly storedSha256: string;
  readonly sizeBytes: number;
}

const systemClock: SyncEngineRuntimeClock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

function sha256Hex(value: Sha256): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(value);
  if (!match) throw new TypeError('SHA-256 must use sha256:<lowercase hex>');
  return match[1];
}

function protocolSha256(value: string): Sha256 {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('stored SHA-256 is malformed');
  return `sha256:${value}` as Sha256;
}

function opaqueId(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

/** Canonical SQLite identity for one provider object inside a SyncGeneration. */
export function syncRemoteObjectId(syncGenerationId: string, providerObjectId: string): string {
  return opaqueId(['remote', syncGenerationId, providerObjectId]);
}

function localObjectId(syncGenerationId: string, logicalKeyId: string): string {
  return opaqueId(['local-object', syncGenerationId, logicalKeyId]);
}

function observedProviderCursor(cursor: string): string {
  return opaqueId(['provider-cursor', cursor]);
}

function segmentId(input: {
  syncGenerationId: string;
  writerId: string;
  writerEpoch: string;
  firstSeq: number;
  lastSeq: number;
}): string {
  return opaqueId([
    'segment',
    input.syncGenerationId,
    input.writerId,
    input.writerEpoch,
    input.firstSeq,
    input.lastSeq,
  ]);
}

function canonicalSegmentLogicalKey(segment: SegmentV1): string {
  const header = segment.header;
  return [
    'segment',
    header.syncGenerationId,
    header.writerId,
    header.writerEpoch,
    `${header.firstSeq}-${header.lastSeq}`,
  ].join('/');
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(`SyncEngine cycle cancelled: ${String(signal.reason ?? 'aborted')}`);
}

function isInvalidProviderToken(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code: unknown }).code)
    .trim()
    .replaceAll('-', '_')
    .toUpperCase();
  return code === 'INVALID_CURSOR' || code === 'INVALID_PAGE_TOKEN';
}

function emptyPageReceipt(): MutablePageReceipt {
  return {
    itemCount: 0,
    durableInbox: 0,
    dependencyPending: 0,
    quarantinedWithRawBytes: 0,
    removedRecorded: 0,
  };
}

type MutablePageReceipt = {
  -readonly [K in keyof DurablePageReceipt]: DurablePageReceipt[K];
};

function remoteObjectFromRow(row: DownloadedSegmentRow): RemoteObject {
  return {
    objectId: row.providerObjectId as ProviderObjectId,
    objectKind: 'segment',
    logicalKeyId: row.logicalKeyId,
    storedSha256: protocolSha256(row.storedSha256),
    sizeBytes: row.sizeBytes,
  };
}

function decodeRequiredBlobIds(value: unknown): readonly string[] {
  const decoded = decodeCanonicalCbor(value as Uint8Array);
  if (
    !decoded.ok ||
    !Array.isArray(decoded.value) ||
    decoded.value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('persisted segment requiredBlobIds are malformed');
  }
  return decoded.value as string[];
}

function quarantineState(reason: string): 'blocked-update' | 'blocked-corrupt' {
  return reason === 'unsupported-protocol-version' || reason === 'unsupported-payload-version'
    ? 'blocked-update'
    : 'blocked-corrupt';
}

export class SqliteSyncGenerationRuntime {
  readonly syncGenerationId: string;
  readonly projectId?: string;

  private readonly db: DbClient;
  private readonly provider: ObjectLogProvider;
  private readonly providerBinding: ProviderBinding;
  private readonly objectCodec: SyncEngineObjectCodec;
  private readonly blobPort: SyncEngineBlobPort | null;
  private readonly writerIdentity: SyncWriterIdentitySource;
  private readonly domainKernel: SyncDomainMaterializationKernel;
  private readonly clock: SyncEngineRuntimeClock;
  private readonly flushLocalDurability: () => Promise<void>;
  private readonly checkpoint?: SyncEngineCheckpointHook;
  private readonly reconcileOpenYjsDocuments?: SqliteSyncGenerationRuntimeOptions['reconcileOpenYjsDocuments'];
  private readonly onRemoteChangeCommitted?: SqliteSyncGenerationRuntimeOptions['onRemoteChangeCommitted'];
  private readonly onStatus?: (runtime: SqliteSyncGenerationRuntime) => void;
  private readonly statusListeners = new Set<(runtime: SqliteSyncGenerationRuntime) => void>();
  private readonly stateRepository: SqliteSyncEngineStateRepository;
  private providerGenerationPromise: Promise<ProviderGeneration> | null = null;
  private activeTriggers: ReadonlySet<SchedulerTrigger> = new Set();
  private readonly lane: SyncGenerationCycleLane;

  constructor(options: SqliteSyncGenerationRuntimeOptions) {
    if (options.providerBinding.syncGenerationId !== options.syncGenerationId) {
      throw new Error('provider binding SyncGeneration does not match runtime SyncGeneration');
    }
    this.db = options.db;
    this.syncGenerationId = options.syncGenerationId;
    this.projectId = options.projectId;
    this.provider = options.provider;
    this.providerBinding = options.providerBinding;
    this.objectCodec = options.objectCodec;
    this.blobPort = options.blobPort ?? null;
    this.writerIdentity = options.writerIdentity;
    this.domainKernel = options.domainKernel;
    this.clock = options.clock ?? systemClock;
    this.flushLocalDurability = options.flushLocalDurability ?? (async () => {});
    this.checkpoint = options.checkpoint;
    this.reconcileOpenYjsDocuments = options.reconcileOpenYjsDocuments;
    this.onRemoteChangeCommitted = options.onRemoteChangeCommitted;
    this.onStatus = options.onStatus;
    this.stateRepository = new SqliteSyncEngineStateRepository(this.db);
    this.lane = new SyncGenerationCycleLane({
      syncGenerationId: this.syncGenerationId,
      clock: this.clock,
      durable: {
        prepare: (signal) => this.prepare(signal),
        ingest: (signal) => this.ingest(signal),
        apply: (signal) => this.apply(signal),
        checkpoint: (signal) => this.checkpoint?.captureIfDue({ syncGenerationId: this.syncGenerationId, signal }) ?? Promise.resolve(false),
        inspectPending: async (signal) => {
          assertNotAborted(signal);
          const pending = await this.inspectPending();
          return {
            hasPending:
              pending.pendingChangeSets > 0 ||
              pending.pendingSegments > 0 ||
              pending.pendingTransfers > 0,
            hasGap: pending.openGaps > 0,
            hasConflict: pending.openConflicts > 0,
            hasQuarantine: pending.quarantinedObjects > 0,
          };
        },
      },
      provider: {
        pull: (signal) => this.pull(signal),
        publishBlobs: (signal) => this.publishBlobs(signal),
        publishSegments: (signal) => this.publishSegments(signal),
      },
      onPhaseChange: () => this.emitStatus(),
    });
  }

  get status() {
    return this.lane.status;
  }

  subscribeStatus(listener: (runtime: SqliteSyncGenerationRuntime) => void): () => void {
    this.statusListeners.add(listener);
    listener(this);
    return () => this.statusListeners.delete(listener);
  }

  async runCycle(
    triggers: ReadonlySet<SchedulerTrigger>,
    signal: AbortSignal,
  ): Promise<SyncGenerationCycleResult> {
    if (!(await this.bindingAllowsCycle())) {
      return Object.freeze({
        pulledObjects: 0,
        publishedBlobs: 0,
        publishedSegments: 0,
        checkpointCreated: false,
        converged: false,
        requiresRepull: false,
      });
    }
    this.activeTriggers = new Set(triggers);
    try {
      const result = await this.lane.run(signal);
      await this.persistSuccessfulCycleStatus(result);
      this.emitStatus();
      return result;
    } catch (error) {
      await this.persistFailureBindingState(error);
      throw error;
    } finally {
      this.activeTriggers = new Set();
      this.emitStatus();
    }
  }

  private async bindingAllowsCycle(): Promise<boolean> {
    const rows = await this.db
      .select({
        state: SyncProviderBindingTable.state,
        generationStatus: SyncGenerationTable.status,
      })
      .from(SyncProviderBindingTable)
      .innerJoin(SyncGenerationTable, eq(SyncGenerationTable.syncGenerationId, SyncProviderBindingTable.syncGenerationId))
      .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId))
      .limit(1);
    return rows[0]?.state === 'ready' && rows[0]?.generationStatus === 'active';
  }

  private async persistFailureBindingState(error: unknown): Promise<void> {
    if (!error || typeof error !== 'object') return;
    const code = 'code' in error ? String((error as { code: unknown }).code) : '';
    const state = code === 'needs-reauth' || code === 'permission-denied'
      ? 'needs-reauth'
      : [
          'REMOTE_STORE_CORRUPT',
          'HASH_MISMATCH',
          'IMMUTABLE_OBJECT_CONFLICT',
          'remote-corrupt',
          'local-object-invalid',
          'immutable-conflict',
        ].includes(code)
        ? 'blocked-corrupt'
        : null;
    if (!state) return;
    await this.db
      .update(SyncProviderBindingTable)
      .set({ state, updatedAt: this.clock.nowIso() })
      .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId));
  }

  private emitStatus(): void {
    this.onStatus?.(this);
    for (const listener of this.statusListeners) listener(this);
  }

  private async persistSuccessfulCycleStatus(result: SyncGenerationCycleResult): Promise<void> {
    const status = this.lane.status;
    const lastPullSuccessAt = status.lastPullSuccessAtMs === null
      ? null
      : new Date(status.lastPullSuccessAtMs).toISOString();
    const lastPublishSuccessAt = status.lastPublishSuccessAtMs === null
      ? null
      : new Date(status.lastPublishSuccessAtMs).toISOString();
    const lastConvergedAt = result.converged && status.lastConvergedAtMs !== null
      ? new Date(status.lastConvergedAtMs).toISOString()
      : null;
    await this.db
      .update(SyncProviderBindingTable)
      .set({
        lastPullSuccessAt,
        lastPublishSuccessAt,
        ...(lastConvergedAt ? { lastConvergedAt } : {}),
        updatedAt: this.clock.nowIso(),
      })
      .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId));
  }

  async inspectPending(): Promise<SyncGenerationPendingDiagnostics> {
    const [
      localChanges,
      segments,
      transferCount,
      gapCount,
      conflictCount,
      quarantineCount,
      removedRemoteCount,
    ] = await Promise.all([
        this.db
          .select({
            writerId: SyncChangeSetTable.writerId,
            writerEpoch: SyncChangeSetTable.writerEpoch,
            deviceSeq: SyncChangeSetTable.deviceSeq,
          })
          .from(SyncChangeSetTable)
          .where(
            and(
              eq(SyncChangeSetTable.syncGenerationId, this.syncGenerationId),
              eq(SyncChangeSetTable.origin, 'local'),
            ),
          ),
        this.db
          .select({
            writerId: SyncSegmentTable.writerId,
            writerEpoch: SyncSegmentTable.writerEpoch,
            firstSeq: SyncSegmentTable.firstSeq,
            lastSeq: SyncSegmentTable.lastSeq,
            state: SyncSegmentTable.state,
          })
          .from(SyncSegmentTable)
          .where(eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId)),
        this.db
          .select({ value: count() })
          .from(SyncTransferTable)
          .where(
            and(
              eq(SyncTransferTable.syncGenerationId, this.syncGenerationId),
              inArray(SyncTransferTable.state, ['pending', 'running', 'retry-wait']),
            ),
          ),
        this.db
          .select({ value: count() })
          .from(SyncFrontierGapTable)
          .where(
            and(
              eq(SyncFrontierGapTable.syncGenerationId, this.syncGenerationId),
              eq(SyncFrontierGapTable.state, 'open'),
            ),
          ),
        this.db
          .select({ value: count() })
          .from(SyncConflictTable)
          .where(
            and(
              eq(SyncConflictTable.syncGenerationId, this.syncGenerationId),
              eq(SyncConflictTable.state, 'open'),
            ),
          ),
        this.db
          .select({ value: count() })
          .from(SyncQuarantinedObjectTable)
          .where(
            and(
              eq(SyncQuarantinedObjectTable.syncGenerationId, this.syncGenerationId),
              inArray(SyncQuarantinedObjectTable.state, ['blocked-update', 'blocked-corrupt']),
            ),
          ),
        this.db
          .select({ value: count() })
          .from(SyncRemoteObjectTable)
          .where(
            and(
              eq(SyncRemoteObjectTable.syncGenerationId, this.syncGenerationId),
              isNotNull(SyncRemoteObjectTable.removedAt),
            ),
          ),
      ]);
    const pendingChangeSets = localChanges.filter((changeSet) =>
      !segments.some((segment) =>
        segment.writerId === changeSet.writerId &&
        segment.writerEpoch === changeSet.writerEpoch &&
        segment.firstSeq <= changeSet.deviceSeq &&
        segment.lastSeq >= changeSet.deviceSeq,
      ),
    ).length;
    const frontierByWriter = new Map<string, Awaited<ReturnType<SqliteSyncEngineStateRepository['loadWriterFrontier']>>>();
    for (const segment of segments) {
      const key = `${segment.writerId}\u0000${segment.writerEpoch}`;
      if (!frontierByWriter.has(key)) {
        frontierByWriter.set(key, await this.stateRepository.loadWriterFrontier({
          syncGenerationId: this.syncGenerationId,
          writerId: segment.writerId,
          writerEpoch: segment.writerEpoch,
        }));
      }
    }
    const pendingSegments = segments.filter((segment) => {
      if (segment.state === 'sealed' || segment.state === 'publishing') return true;
      const frontier = frontierByWriter.get(`${segment.writerId}\u0000${segment.writerEpoch}`);
      return !frontier || !isFrontierRangeComplete(frontier.applied, {
        firstSeq: segment.firstSeq,
        lastSeq: segment.lastSeq,
      });
    }).length;
    return {
      pendingChangeSets,
      pendingSegments,
      pendingTransfers: Number(transferCount[0]?.value ?? 0),
      openGaps: Number(gapCount[0]?.value ?? 0),
      openConflicts: Number(conflictCount[0]?.value ?? 0),
      quarantinedObjects:
        Number(quarantineCount[0]?.value ?? 0) +
        Number(removedRemoteCount[0]?.value ?? 0),
    };
  }

  private async identity(): Promise<SyncGenerationIdentity> {
    const rows = await this.db
      .select({
        projectId: SyncGenerationTable.projectId,
        projectSyncId: SyncGenerationTable.projectSyncId,
        status: SyncGenerationTable.status,
      })
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, this.syncGenerationId))
      .limit(1);
    const generation = rows[0];
    if (!generation || generation.status !== 'active') {
      throw new Error(`SyncEngine SyncGeneration ${this.syncGenerationId} is not an active project SyncGeneration`);
    }
    if (generation.projectId) {
      return { projectId: generation.projectId, projectSyncId: generation.projectSyncId, syncGenerationId: this.syncGenerationId };
    }
    const detachedRows = await this.db
      .select({ projectId: SyncChangeSetTable.projectId })
      .from(SyncChangeSetTable)
      .where(eq(SyncChangeSetTable.syncGenerationId, this.syncGenerationId));
    const detachedProjectIds = new Set(detachedRows.map((row) => row.projectId));
    if (detachedProjectIds.size !== 1) {
      throw new Error(
        `Detached SyncEngine SyncGeneration ${this.syncGenerationId} has no unambiguous terminal project identity`,
      );
    }
    return {
      projectId: [...detachedProjectIds][0]!,
      projectSyncId: generation.projectSyncId,
      syncGenerationId: this.syncGenerationId,
    };
  }

  private providerGeneration(): Promise<ProviderGeneration> {
    this.providerGenerationPromise ??= this.provider.openGeneration(this.providerBinding);
    return this.providerGenerationPromise;
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    await this.flushLocalDurability();
    assertNotAborted(signal);
    await this.prepareLocalBlobs(signal);
    assertNotAborted(signal);
    await this.sealLocalChangeSets(signal);
  }

  private assetDeclarations(
    changeSets: readonly import('../protocol').SyncChangeSetV1[],
  ): readonly SyncAssetBlobDeclaration[] {
    const declarations = new Map<string, SyncAssetBlobDeclaration>();
    for (const changeSet of changeSets) {
      for (const mutation of changeSet.mutations) {
        if (mutation.action !== 'asset.bind') continue;
        const parsed = parseProjectAssetMutationV1(mutation);
        if (!parsed.ok || parsed.value.action !== 'asset.bind') {
          throw new Error('asset.bind declaration does not match protocol v1');
        }
        const issues = validateProjectAssetBindSemantics(parsed.value.payload);
        if (issues.length > 0) {
          throw new Error(`asset.bind declaration is invalid: ${issues[0]?.message ?? 'unknown'}`);
        }
        const declaration: SyncAssetBlobDeclaration = {
          assetId: mutation.target.id,
          blobId: parsed.value.payload.blobId,
          sourceSha256: parsed.value.payload.sourceSha256,
          sourceSizeBytes: parsed.value.payload.sourceSizeBytes,
          sourceMime: parsed.value.payload.sourceMime,
        };
        const key = `${declaration.blobId}\u0000${declaration.assetId}`;
        const existing = declarations.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(declaration)) {
          throw new Error('one asset has conflicting immutable blob declarations');
        }
        declarations.set(key, declaration);
      }
    }
    return [...declarations.values()].sort((left, right) =>
      left.blobId === right.blobId
        ? compareUtf8Bytewise(left.assetId, right.assetId)
        : compareUtf8Bytewise(left.blobId, right.blobId),
    );
  }

  private async prepareLocalBlobs(signal: AbortSignal): Promise<void> {
    const rows = await this.db
      .select({ encodedBytes: SyncChangeSetTable.encodedBytes })
      .from(SyncChangeSetTable)
      .where(
        and(
          eq(SyncChangeSetTable.syncGenerationId, this.syncGenerationId),
          eq(SyncChangeSetTable.origin, 'local'),
        ),
      );
    const changeSets: import('../protocol').SyncChangeSetV1[] = [];
    for (const row of rows) {
      const decoded = await decodeSyncChangeSetV1(row.encodedBytes as Uint8Array);
      if (!decoded.ok) throw new Error(`local asset journal is invalid: ${decoded.reason}`);
      changeSets.push(decoded.value);
    }
    const declarations = this.assetDeclarations(changeSets);
    if (declarations.length === 0) return;
    if (!this.blobPort) {
      throw new Error('asset journal requires a configured SyncEngine blob port');
    }
    const identity = await this.identity();
    const declarationsByBlob = new Map<string, SyncAssetBlobDeclaration[]>();
    for (const declaration of declarations) {
      const list = declarationsByBlob.get(declaration.blobId) ?? [];
      list.push(declaration);
      declarationsByBlob.set(declaration.blobId, list);
    }
    for (const [blobId, candidates] of declarationsByBlob) {
      assertNotAborted(signal);
      const existing = await this.db
        .select()
        .from(SyncBlobStateTable)
        .where(
          and(
            eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
            eq(SyncBlobStateTable.blobId, blobId),
          ),
        )
        .limit(1);
      if (existing[0]?.localState === 'verified') {
        const declaration = candidates[0]!;
        if (
          existing[0].contentSha256 !== sha256Hex(declaration.sourceSha256) ||
          existing[0].sizeBytes !== declaration.sourceSizeBytes
        ) {
          throw new Error('verified local blob conflicts with authored immutable metadata');
        }
        continue;
      }
      const declaration = candidates[0]!;
      const prepared = await this.blobPort.prepareOutbound({
        syncGenerationId: this.syncGenerationId,
        projectId: identity.projectId,
        declaration,
      });
      if (prepared.contentSha256 !== declaration.sourceSha256) {
        throw new Error('prepared outbound blob changed immutable source identity');
      }
      const objectId = localObjectId(this.syncGenerationId, prepared.logicalKeyId);
      const nowIso = this.clock.nowIso();
      await this.db.transaction(async (tx) => {
        await tx
          .insert(SyncLocalObjectTable)
          .values({
            id: objectId,
            syncGenerationId: this.syncGenerationId,
            objectKind: 'blob',
            logicalKeyId: prepared.logicalKeyId,
            storageRef: prepared.sourceRef,
            storedSha256: sha256Hex(prepared.storedSha256),
            contentSha256: sha256Hex(prepared.contentSha256),
            sizeBytes: prepared.sizeBytes,
            codec: 'raw',
            state: 'verified',
            createdAt: nowIso,
            verifiedAt: nowIso,
          })
          .onConflictDoUpdate({
            target: SyncLocalObjectTable.id,
            set: {
              storageRef: prepared.sourceRef,
              storedSha256: sha256Hex(prepared.storedSha256),
              contentSha256: sha256Hex(prepared.contentSha256),
              sizeBytes: prepared.sizeBytes,
              state: 'verified',
              verifiedAt: nowIso,
            },
          });
        await tx
          .insert(SyncBlobStateTable)
          .values({
            syncGenerationId: this.syncGenerationId,
            blobId,
            assetId: declaration.assetId,
            logicalKeyId: prepared.logicalKeyId,
            contentSha256: sha256Hex(declaration.sourceSha256),
            sizeBytes: declaration.sourceSizeBytes,
            mime: declaration.sourceMime,
            localObjectId: objectId,
            localState: 'verified',
            remoteState: 'missing',
            verifiedAt: nowIso,
            updatedAt: nowIso,
          })
          .onConflictDoUpdate({
            target: [SyncBlobStateTable.syncGenerationId, SyncBlobStateTable.blobId],
            set: {
              localObjectId: objectId,
              localState: 'verified',
              verifiedAt: nowIso,
              updatedAt: nowIso,
            },
          });
      });
    }
  }

  private flushReason(): Extract<SegmentFlushReason, 'manual' | 'lifecycle'> | null {
    if (this.activeTriggers.has('manual')) return 'manual';
    if (this.activeTriggers.has('lifecycle-flush')) return 'lifecycle';
    return null;
  }

  private async sealLocalChangeSets(signal: AbortSignal): Promise<void> {
    const identity = await this.identity();
    const activeWriter = (await this.db
      .select({
        writerId: SyncGenerationWriterStateTable.writerId,
        writerEpoch: SyncGenerationWriterStateTable.writerEpoch,
      })
      .from(SyncGenerationWriterStateTable)
      .where(
        and(
          eq(SyncGenerationWriterStateTable.syncGenerationId, this.syncGenerationId),
          eq(SyncGenerationWriterStateTable.installationId, this.writerIdentity.installationId),
          isNull(SyncGenerationWriterStateTable.retiredAt),
        ),
      )
      .limit(1))[0];
    // A restored checkpoint has no outbound history until this installation
    // owns a writer. Source writer lanes are reducer ancestry, never candidates
    // for resealing on the restoring device.
    if (!activeWriter) return;
    const [changeRows, existingSegments] = await Promise.all([
      this.db
        .select({
          writerId: SyncChangeSetTable.writerId,
          writerEpoch: SyncChangeSetTable.writerEpoch,
          deviceSeq: SyncChangeSetTable.deviceSeq,
          encodedBytes: SyncChangeSetTable.encodedBytes,
          createdAt: SyncChangeSetTable.createdAt,
        })
        .from(SyncChangeSetTable)
        .where(
          and(
            eq(SyncChangeSetTable.syncGenerationId, this.syncGenerationId),
            eq(SyncChangeSetTable.origin, 'local'),
            eq(SyncChangeSetTable.writerId, activeWriter.writerId),
            eq(SyncChangeSetTable.writerEpoch, activeWriter.writerEpoch),
          ),
        )
        .orderBy(
          asc(SyncChangeSetTable.writerId),
          asc(SyncChangeSetTable.writerEpoch),
          asc(SyncChangeSetTable.deviceSeq),
        ),
      this.db
        .select()
        .from(SyncSegmentTable)
        .where(
          and(
            eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId),
            eq(SyncSegmentTable.writerId, activeWriter.writerId),
            eq(SyncSegmentTable.writerEpoch, activeWriter.writerEpoch),
          ),
        )
        .orderBy(
          asc(SyncSegmentTable.writerId),
          asc(SyncSegmentTable.writerEpoch),
          asc(SyncSegmentTable.firstSeq),
        ),
    ]);
    if (changeRows.length > 0) {
      assertNotAborted(signal);
      const { writerId, writerEpoch } = activeWriter;
      const lastSegment = existingSegments[existingSegments.length - 1];
      const nextDeviceSeq = (lastSegment?.lastSeq ?? 0) + 1;
      const pendingRows = changeRows.filter(
        (row) =>
          row.writerId === writerId &&
          row.writerEpoch === writerEpoch &&
          row.deviceSeq >= nextDeviceSeq,
      );
      if (pendingRows.length === 0) return;
      if (pendingRows[0]?.deviceSeq !== nextDeviceSeq) {
        throw new Error(
          `local journal lane ${writerId}/${writerEpoch} has a segment gap before ${pendingRows[0]?.deviceSeq}`,
        );
      }
      const segmenter = new ChangeSetSegmenter({
        identity: { ...identity, writerId, writerEpoch },
        nextDeviceSeq,
        previousSegmentHash: lastSegment?.segmentSha256
          ? protocolSha256(lastSegment.segmentSha256)
          : null,
      });
      const sealed: SealedSegment[] = [];
      for (const row of pendingRows) {
        const decoded = await decodeSyncChangeSetV1(row.encodedBytes as Uint8Array);
        if (!decoded.ok) {
          throw new Error(`local journal change-set cannot be segmented: ${decoded.reason}`);
        }
        sealed.push(
          ...(await segmenter.push({
            changeSet: decoded.value,
            enqueuedAtMs: Date.parse(row.createdAt),
          })),
        );
      }
      const reason = this.flushReason();
      const tail = reason
        ? await segmenter.flush(reason)
        : await segmenter.sealExpired(this.clock.nowMs());
      if (tail) sealed.push(tail);
      for (const segment of sealed) {
        assertNotAborted(signal);
        await this.persistSealedSegment(segment);
      }
    }
  }

  private async persistSealedSegment(sealed: SealedSegment): Promise<void> {
    const canonicalLogicalKey = canonicalSegmentLogicalKey(sealed.segment);
    const prepared = await this.objectCodec.prepareOutbound({
      syncGenerationId: this.syncGenerationId,
      objectKind: 'segment',
      canonicalLogicalKey,
      protocolBytes: sealed.encodedBytes,
    });
    if (prepared.contentSha256 !== sealed.segmentSha256) {
      throw new Error('outbound object codec changed the segment content hash');
    }
    const header = sealed.segment.header;
    const id = segmentId(header);
    const localId = localObjectId(this.syncGenerationId, prepared.logicalKeyId);
    const nowIso = this.clock.nowIso();
    const frontier = await this.stateRepository.loadWriterFrontier({
      syncGenerationId: this.syncGenerationId,
      writerId: header.writerId,
      writerEpoch: header.writerEpoch,
    });
    const range = { firstSeq: header.firstSeq, lastSeq: header.lastSeq };
    const received = observeFrontierRange(frontier, 'received', range);
    const applied = setAppliedSegmentHead(
      observeFrontierRange(received, 'applied', range),
      { lastSeq: header.lastSeq, sha256: sealed.segmentSha256 },
    );

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ segmentSha256: SyncSegmentTable.segmentSha256 })
        .from(SyncSegmentTable)
        .where(
          and(
            eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId),
            eq(SyncSegmentTable.writerId, header.writerId),
            eq(SyncSegmentTable.writerEpoch, header.writerEpoch),
            eq(SyncSegmentTable.firstSeq, header.firstSeq),
            eq(SyncSegmentTable.lastSeq, header.lastSeq),
          ),
        )
        .limit(1);
      if (existing[0] && existing[0].segmentSha256 !== sha256Hex(sealed.segmentSha256)) {
        throw new Error('local segment range collides with different bytes');
      }
      if (!existing[0]) {
        await tx.insert(SyncLocalObjectTable).values({
          id: localId,
          syncGenerationId: this.syncGenerationId,
          objectKind: 'segment',
          logicalKeyId: prepared.logicalKeyId,
          storageRef: prepared.sourceRef,
          storedSha256: sha256Hex(prepared.storedSha256),
          contentSha256: sha256Hex(prepared.contentSha256),
          sizeBytes: prepared.sizeBytes,
          codec: prepared.codec,
          state: 'verified',
          createdAt: nowIso,
          verifiedAt: nowIso,
        });
        await tx.insert(SyncSegmentTable).values({
          segmentId: id,
          syncGenerationId: this.syncGenerationId,
          writerId: header.writerId,
          writerEpoch: header.writerEpoch,
          firstSeq: header.firstSeq,
          lastSeq: header.lastSeq,
          changeSetCount: header.opCount,
          previousSegmentSha256: header.previousSegmentHash
            ? sha256Hex(header.previousSegmentHash)
            : null,
          requiredBlobIdsCbor: encodeCanonicalCbor([...header.requiredBlobIds]),
          localObjectId: localId,
          segmentSha256: sha256Hex(sealed.segmentSha256),
          state: 'sealed',
          createdAt: nowIso,
        });
      }
      await persistWriterFrontierInTransaction(tx, applied, nowIso);
    });
  }

  private async pull(signal: AbortSignal): Promise<{ objectCount: number }> {
    const generation = await this.providerGeneration();
    const providerEpoch = syncProviderEpoch(this.provider.kind, this.providerBinding);
    let invalidTokenRecoveries = 0;
    let state = await this.stateRepository.loadCursor(this.syncGenerationId);
    if (state && state.providerEpoch !== providerEpoch) {
      throw new Error('provider authority changed without a new SyncGeneration generation');
    }
    state ??= createDurableCursorState(providerEpoch);
    for (;;) {
      let objectCount = 0;

      try {
        if (!state.inventoryComplete) {
          if (!state.inventory) {
            assertNotAborted(signal);
            const startCursor = await this.provider.captureStartCursor(generation);
            state = beginInventory(state, startCursor);
            await this.stateRepository.persistCursor(this.syncGenerationId, state, this.clock.nowIso());
          }
          for (let pageIndex = 0; pageIndex < MAX_PROVIDER_PAGES_PER_CYCLE; pageIndex += 1) {
            assertNotAborted(signal);
            const inventoryObservationCursor = state.inventory!.startCursor;
            const requestedPageToken = currentInventoryPageToken(state);
            const page = await this.provider.listInventory({
              generation,
              ...(requestedPageToken ? { pageToken: requestedPageToken } : {}),
            });
            const receipt = await this.stageRemoteItems(
              generation,
              page.objects.map((object) => ({ kind: 'present', object })),
              signal,
              observedProviderCursor(inventoryObservationCursor),
            );
            objectCount += page.objects.length;
            state = commitDurableInventoryPage(state, {
              ...(requestedPageToken ? { requestedPageToken } : {}),
              ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
              receipt,
            });
            const persisted = await this.stateRepository.persistInventoryCursor(
              this.syncGenerationId,
              state,
              this.clock.nowIso(),
            );
            if (persisted.missingObjectCount > 0) {
              throw new Error(
                `full provider inventory omitted ${persisted.missingObjectCount} previously observed immutable object(s); sync is blocked-corrupt`,
              );
            }
            if (!page.nextPageToken) break;
            if (pageIndex === MAX_PROVIDER_PAGES_PER_CYCLE - 1) {
              throw new Error('provider inventory exceeded the per-cycle page safety limit');
            }
          }
        }

        for (let pageIndex = 0; pageIndex < MAX_PROVIDER_PAGES_PER_CYCLE; pageIndex += 1) {
          assertNotAborted(signal);
          const request = currentChangePageRequest(state);
          const page = await this.provider.listChanges({ generation, ...request });
          const receipt = await this.stageRemoteItems(
            generation,
            page.changes,
            signal,
            observedProviderCursor(request.cursor),
          );
          objectCount += page.changes.filter((change) => change.kind === 'present').length;
          state = commitDurableChangePage(state, {
            request,
            ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
            ...(page.newCursor ? { newCursor: page.newCursor } : {}),
            receipt,
          });
          await this.stateRepository.persistCursor(this.syncGenerationId, state, this.clock.nowIso());
          if (!page.nextPageToken) break;
          if (pageIndex === MAX_PROVIDER_PAGES_PER_CYCLE - 1) {
            throw new Error('provider changes exceeded the per-cycle page safety limit');
          }
        }
        objectCount += await this.stageObservedSegmentBacklog(generation, signal);
        return { objectCount };
      } catch (error) {
        if (
          !isInvalidProviderToken(error) ||
          invalidTokenRecoveries >= MAX_INVALID_TOKEN_RECOVERIES_PER_CYCLE
        ) {
          throw error;
        }
        assertNotAborted(signal);
        await this.stateRepository.resetCursorForFullInventory(this.syncGenerationId);
        state = resetCursorForFullInventory(state);
        invalidTokenRecoveries += 1;
      }
    }
  }

  /**
   * Restore activation can already own a complete provider cursor. Segments
   * observed by that discovery still need a durable local inbox before they
   * can be decoded and applied. Incremental removals are drained first, so a
   * deletion between activation and this first cycle blocks before download.
   */
  private async stageObservedSegmentBacklog(
    generation: ProviderGeneration,
    signal: AbortSignal,
  ): Promise<number> {
    const rows = await this.db
      .select({
        objectId: SyncRemoteObjectTable.providerObjectId,
        logicalKeyId: SyncRemoteObjectTable.logicalKeyId,
        objectKind: SyncRemoteObjectTable.objectKind,
        storedSha256: SyncRemoteObjectTable.storedSha256,
        sizeBytes: SyncRemoteObjectTable.sizeBytes,
        completedTransferId: SyncTransferTable.transferId,
      })
      .from(SyncRemoteObjectTable)
      .leftJoin(
        SyncTransferTable,
        and(
          eq(SyncTransferTable.remoteObjectId, SyncRemoteObjectTable.id),
          eq(SyncTransferTable.direction, 'download'),
          eq(SyncTransferTable.state, 'completed'),
        ),
      )
      .where(
        and(
          eq(SyncRemoteObjectTable.syncGenerationId, this.syncGenerationId),
          eq(SyncRemoteObjectTable.objectKind, 'segment'),
          isNull(SyncRemoteObjectTable.removedAt),
          isNull(SyncTransferTable.transferId),
        ),
      );
    let staged = 0;
    for (const row of rows) {
      assertNotAborted(signal);
      if (row.completedTransferId !== null || row.objectKind !== 'segment') continue;
      await this.stageRemoteObject(
        generation,
        {
          objectId: row.objectId as ProviderObjectId,
          objectKind: 'segment',
          logicalKeyId: row.logicalKeyId,
          storedSha256: protocolSha256(row.storedSha256),
          sizeBytes: row.sizeBytes,
        },
        signal,
      );
      staged += 1;
    }
    return staged;
  }

  private async stageRemoteItems(
    generation: ProviderGeneration,
    changes: readonly RemoteObjectChange[],
    signal: AbortSignal,
    observedCursor?: string,
  ): Promise<DurablePageReceipt> {
    const receipt = emptyPageReceipt();
    receipt.itemCount = changes.length;
    for (const change of changes) {
      assertNotAborted(signal);
      if (change.kind === 'removed') {
        const knownObjectRemoved = await this.recordRemoteRemoval(change);
        receipt.removedRecorded += 1;
        if (knownObjectRemoved) {
          throw new Error(
            'provider removed a previously observed immutable object; sync is blocked-corrupt',
          );
        }
        continue;
      }
      const disposition = await this.stageRemoteObject(
        generation,
        change.object,
        signal,
        observedCursor,
      );
      if (disposition === 'quarantined') receipt.quarantinedWithRawBytes += 1;
      else receipt.durableInbox += 1;
    }
    return receipt;
  }

  private async recordRemoteRemoval(
    change: Extract<RemoteObjectChange, { kind: 'removed' }>,
  ): Promise<boolean> {
    const nowIso = this.clock.nowIso();
    return this.db.transaction(async (tx) => {
      const [known] = await tx
        .select({ id: SyncRemoteObjectTable.id })
        .from(SyncRemoteObjectTable)
        .where(
          and(
            eq(SyncRemoteObjectTable.syncGenerationId, this.syncGenerationId),
            eq(SyncRemoteObjectTable.providerObjectId, change.objectId),
          ),
        )
        .limit(1);
      if (!known) return false;
      await tx
        .update(SyncRemoteObjectTable)
        .set({ removedAt: nowIso, lastObservedAt: nowIso })
        .where(eq(SyncRemoteObjectTable.id, known.id));
      // Provider removal is transport degradation, never a domain tombstone.
      // v1 retains every immutable object, so losing any previously observed
      // object blocks convergence until an explicit repair proves the exact
      // bytes are available again.
      await tx
        .update(SyncProviderBindingTable)
        .set({ state: 'blocked-corrupt', updatedAt: nowIso })
        .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId));
      return true;
    });
  }

  private async stageRemoteObject(
    generation: ProviderGeneration,
    remote: RemoteObject,
    signal: AbortSignal,
    observedCursor?: string,
  ): Promise<'inbox' | 'quarantined'> {
    const prepared = await this.prepareDownload(remote, observedCursor);
    if (!prepared.downloadRequired) return prepared.quarantineCollision ? 'quarantined' : 'inbox';
    try {
      const result = await this.provider.downloadImmutable({
        generation,
        objectId: remote.objectId,
        destinationRef: prepared.destinationRef,
        expectedStoredSha256: remote.storedSha256,
        transferId: prepared.transferId,
        signal,
      });
      if (
        result.destinationRef !== prepared.destinationRef ||
        result.storedSha256 !== remote.storedSha256 ||
        result.sizeBytes !== remote.sizeBytes
      ) {
        throw new Error('provider returned inconsistent immutable download metadata');
      }
      const nowIso = this.clock.nowIso();
      await this.db.transaction(async (tx) => {
        await tx
          .update(SyncLocalObjectTable)
          .set({
            state: prepared.quarantineCollision ? 'quarantined' : 'staged',
            verifiedAt: null,
          })
          .where(eq(SyncLocalObjectTable.id, prepared.localObjectId));
        await tx
          .update(SyncTransferTable)
          .set({
            state: 'completed',
            transferredBytes: remote.sizeBytes,
            updatedAt: nowIso,
            completedAt: nowIso,
            lastErrorCode: null,
            nextAttemptAt: null,
          })
          .where(eq(SyncTransferTable.transferId, prepared.transferId));
        if (prepared.quarantineCollision) {
          await this.insertQuarantine(tx, {
            remoteId: prepared.remoteId,
            localObjectId: prepared.localObjectId,
            reason: 'logical-key-object-collision',
            storedSha256: remote.storedSha256,
            sizeBytes: remote.sizeBytes,
            state: 'blocked-corrupt',
          });
        }
      });
      return prepared.quarantineCollision ? 'quarantined' : 'inbox';
    } catch (error) {
      const nowIso = this.clock.nowIso();
      await this.db
        .update(SyncTransferTable)
        .set({
          state: 'retry-wait',
          updatedAt: nowIso,
          lastErrorCode:
            typeof error === 'object' && error && 'code' in error
              ? String((error as { code: unknown }).code)
              : 'DOWNLOAD_FAILED',
          nextAttemptAt: nowIso,
        })
        .where(eq(SyncTransferTable.transferId, prepared.transferId));
      throw error;
    }
  }

  private async prepareDownload(
    remote: RemoteObject,
    observedCursor?: string,
  ): Promise<DurableDownload> {
    const transferId = await createProviderTransferId({
      direction: 'download',
      syncGenerationId: this.syncGenerationId,
      objectIdentity: remote.objectId,
    });
    const remoteId = syncRemoteObjectId(this.syncGenerationId, remote.objectId);
    const existingRemote = await this.db
      .select()
      .from(SyncRemoteObjectTable)
      .where(
        and(
          eq(SyncRemoteObjectTable.syncGenerationId, this.syncGenerationId),
          eq(SyncRemoteObjectTable.providerObjectId, remote.objectId),
        ),
      )
      .limit(1);
    if (
      existingRemote[0] &&
      (existingRemote[0].logicalKeyId !== remote.logicalKeyId ||
        existingRemote[0].objectKind !== remote.objectKind ||
        existingRemote[0].storedSha256 !== sha256Hex(remote.storedSha256) ||
        existingRemote[0].sizeBytes !== remote.sizeBytes)
    ) {
      throw new Error(`provider object ${remote.objectId} changed immutable metadata`);
    }

    const logicalRows = await this.db
      .select()
      .from(SyncLocalObjectTable)
      .where(
        and(
          eq(SyncLocalObjectTable.syncGenerationId, this.syncGenerationId),
          eq(SyncLocalObjectTable.logicalKeyId, remote.logicalKeyId),
        ),
      )
      .limit(1);
    const logical = logicalRows[0];
    const identityMatches =
      logical &&
      logical.objectKind === remote.objectKind &&
      logical.storedSha256 === sha256Hex(remote.storedSha256) &&
      logical.sizeBytes === remote.sizeBytes;
    const nowIso = this.clock.nowIso();
    if (identityMatches && logical && ['verified', 'published'].includes(logical.state)) {
      await this.upsertRemoteObject(remote, remoteId, nowIso, this.db, observedCursor);
      return {
        remoteId,
        localObjectId: logical.id,
        destinationRef: createLocalObjectRef(logical.storageRef),
        transferId,
        downloadRequired: false,
        quarantineCollision: false,
      };
    }

    const quarantineCollision = Boolean(logical && !identityMatches);
    const durableLogicalKey = quarantineCollision
      ? opaqueId(['quarantine', remote.objectId, remote.storedSha256])
      : remote.logicalKeyId;
    const durableLocalId = localObjectId(this.syncGenerationId, durableLogicalKey);
    const priorTransfer = await this.db
      .select({
        state: SyncTransferTable.state,
        localObjectId: SyncTransferTable.localObjectId,
        storageRef: SyncLocalObjectTable.storageRef,
      })
      .from(SyncTransferTable)
      .leftJoin(
        SyncLocalObjectTable,
        eq(SyncLocalObjectTable.id, SyncTransferTable.localObjectId),
      )
      .where(eq(SyncTransferTable.transferId, transferId))
      .limit(1);
    const destinationRef = priorTransfer[0]?.storageRef
      ? createLocalObjectRef(priorTransfer[0].storageRef)
      : await this.objectCodec.allocateInbound({ syncGenerationId: this.syncGenerationId, remoteObject: remote });

    await this.db.transaction(async (tx) => {
      await this.upsertRemoteObject(remote, remoteId, nowIso, tx, observedCursor);
      await tx
        .insert(SyncLocalObjectTable)
        .values({
          id: durableLocalId,
          syncGenerationId: this.syncGenerationId,
          objectKind: quarantineCollision ? 'quarantine' : remote.objectKind,
          logicalKeyId: durableLogicalKey,
          storageRef: destinationRef,
          storedSha256: sha256Hex(remote.storedSha256),
          contentSha256: null,
          sizeBytes: remote.sizeBytes,
          codec: 'opaque',
          state: 'staged',
          createdAt: nowIso,
        })
        .onConflictDoUpdate({
          target: SyncLocalObjectTable.id,
          set: { storageRef: destinationRef, state: 'staged' },
        });
      await tx
        .insert(SyncTransferTable)
        .values({
          transferId,
          syncGenerationId: this.syncGenerationId,
          direction: 'download',
          objectKind: remote.objectKind,
          logicalKeyId: remote.logicalKeyId,
          localObjectId: durableLocalId,
          remoteObjectId: remoteId,
          expectedStoredSha256: sha256Hex(remote.storedSha256),
          totalBytes: remote.sizeBytes,
          transferredBytes: 0,
          state: 'running',
          attemptCount: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: SyncTransferTable.transferId,
          set: {
            state: 'running',
            attemptCount: sql`${SyncTransferTable.attemptCount} + 1`,
            updatedAt: nowIso,
            lastErrorCode: null,
            nextAttemptAt: null,
          },
        });
    });
    return {
      remoteId,
      localObjectId: durableLocalId,
      destinationRef,
      transferId,
      downloadRequired: true,
      quarantineCollision,
    };
  }

  private async upsertRemoteObject(
    remote: RemoteObject,
    id: string,
    nowIso: string,
    executor: DbClient | DbTransaction = this.db,
    observedCursor?: string,
  ): Promise<void> {
    await executor
      .insert(SyncRemoteObjectTable)
      .values({
        id,
        syncGenerationId: this.syncGenerationId,
        providerObjectId: remote.objectId,
        logicalKeyId: remote.logicalKeyId,
        objectKind: remote.objectKind,
        storedSha256: sha256Hex(remote.storedSha256),
        sizeBytes: remote.sizeBytes,
        observedCursor: observedCursor ?? null,
        firstObservedAt: nowIso,
        lastObservedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [SyncRemoteObjectTable.syncGenerationId, SyncRemoteObjectTable.providerObjectId],
        set: {
          lastObservedAt: nowIso,
          removedAt: null,
          ...(observedCursor ? { observedCursor } : {}),
        },
      });
  }

  private async ingest(signal: AbortSignal): Promise<void> {
    const rows = await this.db
      .select({
        remoteId: SyncRemoteObjectTable.id,
        providerObjectId: SyncRemoteObjectTable.providerObjectId,
        logicalKeyId: SyncRemoteObjectTable.logicalKeyId,
        storedSha256: SyncRemoteObjectTable.storedSha256,
        sizeBytes: SyncRemoteObjectTable.sizeBytes,
        localObjectId: SyncLocalObjectTable.id,
        storageRef: SyncLocalObjectTable.storageRef,
      })
      .from(SyncTransferTable)
      .innerJoin(
        SyncRemoteObjectTable,
        eq(SyncRemoteObjectTable.id, SyncTransferTable.remoteObjectId),
      )
      .innerJoin(
        SyncLocalObjectTable,
        eq(SyncLocalObjectTable.id, SyncTransferTable.localObjectId),
      )
      .where(
        and(
          eq(SyncTransferTable.syncGenerationId, this.syncGenerationId),
          eq(SyncTransferTable.direction, 'download'),
          eq(SyncTransferTable.state, 'completed'),
          eq(SyncRemoteObjectTable.objectKind, 'segment'),
          isNull(SyncRemoteObjectTable.removedAt),
          inArray(SyncLocalObjectTable.state, ['staged', 'verified']),
        ),
      );
    for (const row of rows) {
      assertNotAborted(signal);
      const existing = await this.db
        .select({ id: SyncSegmentTable.segmentId })
        .from(SyncSegmentTable)
        .where(eq(SyncSegmentTable.localObjectId, row.localObjectId))
        .limit(1);
      if (existing.length > 0) continue;
      await this.ingestSegment(row, signal);
    }
    if (this.blobPort) {
      const declarations: SyncAssetBlobDeclaration[] = [];
      for (const row of rows) {
        assertNotAborted(signal);
        const decoded = await this.decodeDownloadedSegment(row);
        if (decoded) declarations.push(...this.assetDeclarations(decoded.segment.changeSets));
      }
      await this.ingestDownloadedBlobs(
        await this.identity(),
        this.dedupeAssetDeclarations(declarations),
        signal,
      );
    }
  }

  private dedupeAssetDeclarations(
    declarations: readonly SyncAssetBlobDeclaration[],
  ): readonly SyncAssetBlobDeclaration[] {
    const byAsset = new Map<string, SyncAssetBlobDeclaration>();
    for (const declaration of declarations) {
      const key = `${declaration.blobId}\u0000${declaration.assetId}`;
      const existing = byAsset.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(declaration)) {
        throw new Error('remote segments contain conflicting immutable asset declarations');
      }
      byAsset.set(key, declaration);
    }
    return [...byAsset.values()].sort((left, right) =>
      left.blobId === right.blobId
        ? compareUtf8Bytewise(left.assetId, right.assetId)
        : compareUtf8Bytewise(left.blobId, right.blobId),
    );
  }

  private async ingestDownloadedBlobs(
    identity: SyncGenerationIdentity,
    declarations: readonly SyncAssetBlobDeclaration[],
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.blobPort || declarations.length === 0) return;
    const rows = await this.db
      .select({
        remoteId: SyncRemoteObjectTable.id,
        providerObjectId: SyncRemoteObjectTable.providerObjectId,
        logicalKeyId: SyncRemoteObjectTable.logicalKeyId,
        storedSha256: SyncRemoteObjectTable.storedSha256,
        sizeBytes: SyncRemoteObjectTable.sizeBytes,
        localObjectId: SyncLocalObjectTable.id,
        storageRef: SyncLocalObjectTable.storageRef,
      })
      .from(SyncTransferTable)
      .innerJoin(
        SyncRemoteObjectTable,
        eq(SyncRemoteObjectTable.id, SyncTransferTable.remoteObjectId),
      )
      .innerJoin(
        SyncLocalObjectTable,
        eq(SyncLocalObjectTable.id, SyncTransferTable.localObjectId),
      )
      .where(
        and(
          eq(SyncTransferTable.syncGenerationId, this.syncGenerationId),
          eq(SyncTransferTable.direction, 'download'),
          eq(SyncTransferTable.state, 'completed'),
          eq(SyncRemoteObjectTable.objectKind, 'blob'),
          isNull(SyncRemoteObjectTable.removedAt),
          inArray(SyncLocalObjectTable.state, ['staged', 'verified']),
        ),
      );
    for (const row of rows) {
      assertNotAborted(signal);
      const alreadyVerified = await this.db
        .select({ blobId: SyncBlobStateTable.blobId })
        .from(SyncBlobStateTable)
        .where(
          and(
            eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
            eq(SyncBlobStateTable.logicalKeyId, row.logicalKeyId),
            eq(SyncBlobStateTable.localState, 'verified'),
          ),
        )
        .limit(1);
      if (alreadyVerified.length > 0) continue;

      const remote: RemoteObject = {
        objectId: row.providerObjectId as ProviderObjectId,
        objectKind: 'blob',
        logicalKeyId: row.logicalKeyId,
        storedSha256: protocolSha256(row.storedSha256),
        sizeBytes: row.sizeBytes,
      };
      let verified: Awaited<ReturnType<SyncEngineBlobPort['verifyAndInstallInbound']>>;
      try {
        verified = await this.blobPort.verifyAndInstallInbound({
          syncGenerationId: this.syncGenerationId,
          projectId: identity.projectId,
          remoteObject: remote,
          sourceRef: createLocalObjectRef(row.storageRef),
          declarations,
        });
      } catch {
        await this.quarantineDownloaded(
          row,
          'asset-blob-verification-or-install-failed',
          'blocked-corrupt',
        );
        continue;
      }
      if (!verified) continue;
      if (
        verified.logicalKeyId !== row.logicalKeyId ||
        verified.blobId !== verified.contentSha256 ||
        verified.contentSizeBytes < 0
      ) {
        await verified.rollback().catch(() => {});
        await this.quarantineDownloaded(
          row,
          'asset-blob-authenticated-metadata-mismatch',
          'blocked-corrupt',
        );
        continue;
      }
      const existingBlob = await this.db
        .select({
          logicalKeyId: SyncBlobStateTable.logicalKeyId,
          contentSha256: SyncBlobStateTable.contentSha256,
          sizeBytes: SyncBlobStateTable.sizeBytes,
          localState: SyncBlobStateTable.localState,
        })
        .from(SyncBlobStateTable)
        .where(
          and(
            eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
            eq(SyncBlobStateTable.blobId, verified.blobId),
          ),
        )
        .limit(1);
      if (
        existingBlob[0]?.localState === 'verified' &&
        (existingBlob[0].logicalKeyId !== row.logicalKeyId ||
          existingBlob[0].contentSha256 !== sha256Hex(verified.contentSha256) ||
          existingBlob[0].sizeBytes !== verified.contentSizeBytes)
      ) {
        await verified.commit().catch(() => {});
        await this.quarantineDownloaded(
          row,
          'asset-blob-logical-identity-collision',
          'blocked-corrupt',
        );
        continue;
      }

      const nowIso = this.clock.nowIso();
      let sqliteCommitted = false;
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .update(SyncLocalObjectTable)
            .set({
              state: 'verified',
              contentSha256: sha256Hex(verified!.contentSha256),
              verifiedAt: nowIso,
            })
            .where(eq(SyncLocalObjectTable.id, row.localObjectId));
          await tx
            .insert(SyncBlobStateTable)
            .values({
              syncGenerationId: this.syncGenerationId,
              blobId: verified!.blobId,
              assetId: verified!.installedAssetIds[0] ?? null,
              logicalKeyId: row.logicalKeyId,
              contentSha256: sha256Hex(verified!.contentSha256),
              sizeBytes: verified!.contentSizeBytes,
              mime: verified!.mimeType,
              localObjectId: row.localObjectId,
              localState: 'verified',
              remoteState: 'available',
              verifiedAt: nowIso,
              updatedAt: nowIso,
            })
            .onConflictDoUpdate({
              target: [SyncBlobStateTable.syncGenerationId, SyncBlobStateTable.blobId],
              set: {
                localObjectId: row.localObjectId,
                localState: 'verified',
                remoteState: 'available',
                verifiedAt: nowIso,
                updatedAt: nowIso,
              },
            });
        });
        sqliteCommitted = true;
      } finally {
        if (!sqliteCommitted) await verified.rollback().catch(() => {});
      }
      try {
        await verified.commit();
      } catch {
        // SQLite is authoritative that activation completed. Startup native
        // receipt GC may retry staging cleanup; canonical sources stay live.
      }
    }
  }

  private async decodeDownloadedSegment(
    row: DownloadedSegmentRow,
  ): Promise<{ segment: SegmentV1; contentSha256: Sha256 } | null> {
    const remote = remoteObjectFromRow(row);
    let decodedObject;
    try {
      decodedObject = await this.objectCodec.decodeInbound({
        syncGenerationId: this.syncGenerationId,
        expectedLogicalKeyId: row.logicalKeyId,
        remoteObject: remote,
        sourceRef: createLocalObjectRef(row.storageRef),
      });
    } catch {
      await this.quarantineDownloaded(row, 'object-codec-verification-failed', 'blocked-corrupt');
      return null;
    }
    if (decodedObject.objectKind !== 'segment') {
      await this.quarantineDownloaded(row, 'decoded-object-kind-mismatch', 'blocked-corrupt');
      return null;
    }
    if (await sha256Bytes(decodedObject.protocolBytes) !== decodedObject.contentSha256) {
      await this.quarantineDownloaded(row, 'decoded-content-hash-mismatch', 'blocked-corrupt');
      return null;
    }
    const decoded = await decodeSegmentV1(decodedObject.protocolBytes);
    if (!decoded.ok) {
      await this.quarantineDownloaded(row, decoded.reason, quarantineState(decoded.reason));
      return null;
    }
    return { segment: decoded.value, contentSha256: decodedObject.contentSha256 };
  }

  private async ingestSegment(row: DownloadedSegmentRow, signal: AbortSignal): Promise<void> {
    const identity = await this.identity();
    const decoded = await this.decodeDownloadedSegment(row);
    if (!decoded) return;
    assertNotAborted(signal);
    const { segment } = decoded;
    const header = segment.header;
    if (
      header.projectId !== identity.projectId ||
      header.projectSyncId !== identity.projectSyncId ||
      header.syncGenerationId !== identity.syncGenerationId
    ) {
      await this.quarantineDownloaded(row, 'segment-sync-generation-identity-mismatch', 'blocked-corrupt');
      return;
    }
    const range = { firstSeq: header.firstSeq, lastSeq: header.lastSeq };
    const frontier = await this.stateRepository.loadWriterFrontier({
      syncGenerationId: this.syncGenerationId,
      writerId: header.writerId,
      writerEpoch: header.writerEpoch,
    });
    const contiguousApplied = contiguousFrontierSeq(frontier.applied);
    if (header.firstSeq === contiguousApplied + 1) {
      const expectedPreviousHash = contiguousApplied === 0
        ? null
        : frontier.segmentHeadSha256;
      if (header.previousSegmentHash !== expectedPreviousHash) {
        await this.quarantineDownloaded(
          row,
          'segment previous hash does not match the applied checkpoint frontier',
          'blocked-corrupt',
        );
        return;
      }
    }
    const received = observeFrontierRange(frontier, 'received', range);
    const id = segmentId(header);
    const nowIso = this.clock.nowIso();

    await this.db.transaction(async (tx) => {
      const collision = await tx
        .select({
          segmentSha256: SyncSegmentTable.segmentSha256,
        })
        .from(SyncSegmentTable)
        .where(
          and(
            eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId),
            eq(SyncSegmentTable.writerId, header.writerId),
            eq(SyncSegmentTable.writerEpoch, header.writerEpoch),
            eq(SyncSegmentTable.firstSeq, header.firstSeq),
            eq(SyncSegmentTable.lastSeq, header.lastSeq),
          ),
        )
        .limit(1);
      if (collision[0] && collision[0].segmentSha256 !== sha256Hex(decoded.contentSha256)) {
        throw new Error('writer/range fork detected');
      }
      if (!collision[0]) {
        const predecessor = await tx
          .select({ segmentSha256: SyncSegmentTable.segmentSha256 })
          .from(SyncSegmentTable)
          .where(
            and(
              eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId),
              eq(SyncSegmentTable.writerId, header.writerId),
              eq(SyncSegmentTable.writerEpoch, header.writerEpoch),
              eq(SyncSegmentTable.lastSeq, header.firstSeq - 1),
            ),
          )
          .limit(1);
        if (
          predecessor[0] &&
          header.previousSegmentHash !== protocolSha256(predecessor[0].segmentSha256)
        ) {
          throw new Error('segment previous hash does not match its predecessor');
        }
        const successor = await tx
          .select({ previousSegmentSha256: SyncSegmentTable.previousSegmentSha256 })
          .from(SyncSegmentTable)
          .where(
            and(
              eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId),
              eq(SyncSegmentTable.writerId, header.writerId),
              eq(SyncSegmentTable.writerEpoch, header.writerEpoch),
              eq(SyncSegmentTable.firstSeq, header.lastSeq + 1),
            ),
          )
          .limit(1);
        if (
          successor[0] &&
          successor[0].previousSegmentSha256 !== sha256Hex(decoded.contentSha256)
        ) {
          throw new Error('segment hash does not match its successor chain link');
        }
        await tx.insert(SyncSegmentTable).values({
          segmentId: id,
          syncGenerationId: this.syncGenerationId,
          writerId: header.writerId,
          writerEpoch: header.writerEpoch,
          firstSeq: header.firstSeq,
          lastSeq: header.lastSeq,
          changeSetCount: header.opCount,
          previousSegmentSha256: header.previousSegmentHash
            ? sha256Hex(header.previousSegmentHash)
            : null,
          requiredBlobIdsCbor: encodeCanonicalCbor([...header.requiredBlobIds]),
          localObjectId: row.localObjectId,
          segmentSha256: sha256Hex(decoded.contentSha256),
          state: 'published',
          createdAt: nowIso,
          publishedAt: nowIso,
        });
      }
      await tx
        .update(SyncLocalObjectTable)
        .set({
          state: 'verified',
          contentSha256: sha256Hex(decoded.contentSha256),
          verifiedAt: nowIso,
        })
        .where(eq(SyncLocalObjectTable.id, row.localObjectId));
      await persistWriterFrontierInTransaction(tx, received, nowIso);
    }).catch(async (error: unknown) => {
      await this.quarantineDownloaded(
        row,
        error instanceof Error ? error.message : 'segment-ingest-failed',
        'blocked-corrupt',
      );
    });
  }

  private async apply(signal: AbortSignal): Promise<void> {
    const identity = await this.identity();
    // A crash or callback failure after a prior reducer commit cannot rely on
    // that change-set being applied again: its durable receipt/frontier makes
    // the next cycle skip it. Reconcile every open session from its own SQLite
    // coverage cursor before inspecting segment frontiers.
    await this.reconcileOpenYjsDocuments?.({ projectId: identity.projectId });
    const segments = await this.db
      .select({
        segmentId: SyncSegmentTable.segmentId,
        writerId: SyncSegmentTable.writerId,
        writerEpoch: SyncSegmentTable.writerEpoch,
        firstSeq: SyncSegmentTable.firstSeq,
        lastSeq: SyncSegmentTable.lastSeq,
        localObjectId: SyncSegmentTable.localObjectId,
        segmentSha256: SyncSegmentTable.segmentSha256,
        requiredBlobIdsCbor: SyncSegmentTable.requiredBlobIdsCbor,
        state: SyncSegmentTable.state,
      })
      .from(SyncSegmentTable)
      .where(eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId))
      .orderBy(
        asc(SyncSegmentTable.writerId),
        asc(SyncSegmentTable.writerEpoch),
        asc(SyncSegmentTable.firstSeq),
      );
    for (const segmentRow of segments) {
      assertNotAborted(signal);
      const range = { firstSeq: segmentRow.firstSeq, lastSeq: segmentRow.lastSeq };
      const frontier = await this.stateRepository.loadWriterFrontier({
        syncGenerationId: this.syncGenerationId,
        writerId: segmentRow.writerId,
        writerEpoch: segmentRow.writerEpoch,
      });
      if (isFrontierRangeComplete(frontier.applied, range)) continue;
      if (!canAdvanceContiguousFrontier(frontier.applied, range)) continue;
      if (!(await this.requiredBlobsAvailable(segmentRow.requiredBlobIdsCbor))) continue;
      const download = await this.downloadRowForLocalObject(segmentRow.localObjectId);
      if (!download) continue;
      const decoded = await this.decodeDownloadedSegment(download);
      if (!decoded) continue;
      for (const changeSet of decoded.segment.changeSets) {
        let current = await this.stateRepository.loadWriterFrontier({
          syncGenerationId: this.syncGenerationId,
          writerId: segmentRow.writerId,
          writerEpoch: segmentRow.writerEpoch,
        });
        const sequence = { firstSeq: changeSet.deviceSeq, lastSeq: changeSet.deviceSeq };
        if (isFrontierRangeComplete(current.applied, sequence)) continue;
        if (!canAdvanceContiguousFrontier(current.applied, sequence)) break;
        let next = observeFrontierRange(current, 'applied', sequence);
        if (changeSet.deviceSeq === segmentRow.lastSeq) {
          next = setAppliedSegmentHead(next, {
            lastSeq: segmentRow.lastSeq,
            sha256: protocolSha256(segmentRow.segmentSha256),
          });
        }
        try {
          const applied = await this.db.transaction(async (tx) => {
            const result = await applyVerifiedRemoteChangeSetInTransaction(tx, {
              changeSet,
              identity: this.writerIdentity,
              clock: { nowMs: this.clock.nowMs(), nowIso: this.clock.nowIso() },
              kernel: this.domainKernel,
              sourceObjectId: download.remoteId,
            });
            await persistWriterFrontierInTransaction(tx, next, this.clock.nowIso());
            return result;
          });
          const docIds = applied.effects
            .filter((effect) =>
              effect.materialize &&
              effect.type === 'yjs.update' &&
              effect.source.changeSetId === changeSet.changeSetId,
            )
            .map((effect) => effect.target.id);
          if (docIds.length > 0) {
            // This await is intentionally outside the SQLite transaction and
            // before the apply phase can publish its next UI-visible status.
            await this.reconcileOpenYjsDocuments?.({
              projectId: changeSet.projectId,
              docIds,
            });
          }
          this.onRemoteChangeCommitted?.({
            projectId: changeSet.projectId,
            changeSetId: changeSet.changeSetId,
            projectionImpact: remoteProjectChangeProjectionImpact(applied.effects),
          });
        } catch (error) {
          if (error instanceof SyncReducerRejectedError) {
            await this.quarantineDownloaded(
              download,
              `reducer-${error.code}`,
              error.code === 'unknown-target-kind' || error.code === 'unsupported-action'
                ? 'blocked-update'
                : 'blocked-corrupt',
            );
            break;
          }
          throw error;
        }
        current = next;
      }
    }
    await this.retireBindingForPurgedSyncGeneration();
  }

  private async retireBindingForPurgedSyncGeneration(): Promise<void> {
    const generation = (await this.db
      .select({ status: SyncGenerationTable.status })
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, this.syncGenerationId))
      .limit(1))[0];
    if (generation?.status !== 'purged') return;
    await this.db
      .update(SyncProviderBindingTable)
      .set({ state: 'purged', updatedAt: this.clock.nowIso() })
      .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId));
  }

  private async requiredBlobsAvailable(encoded: unknown): Promise<boolean> {
    const ids = decodeRequiredBlobIds(encoded);
    if (ids.length === 0) return true;
    const rows = await this.db
      .select({ blobId: SyncBlobStateTable.blobId })
      .from(SyncBlobStateTable)
      .where(
        and(
          eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
          inArray(SyncBlobStateTable.blobId, [...ids]),
          eq(SyncBlobStateTable.localState, 'verified'),
        ),
      );
    return new Set(rows.map((row) => row.blobId)).size === ids.length;
  }

  private async downloadRowForLocalObject(
    id: string,
  ): Promise<DownloadedSegmentRow | null> {
    const rows = await this.db
      .select({
        remoteId: SyncRemoteObjectTable.id,
        providerObjectId: SyncRemoteObjectTable.providerObjectId,
        logicalKeyId: SyncRemoteObjectTable.logicalKeyId,
        storedSha256: SyncRemoteObjectTable.storedSha256,
        sizeBytes: SyncRemoteObjectTable.sizeBytes,
        localObjectId: SyncLocalObjectTable.id,
        storageRef: SyncLocalObjectTable.storageRef,
      })
      .from(SyncTransferTable)
      .innerJoin(
        SyncRemoteObjectTable,
        eq(SyncRemoteObjectTable.id, SyncTransferTable.remoteObjectId),
      )
      .innerJoin(
        SyncLocalObjectTable,
        eq(SyncLocalObjectTable.id, SyncTransferTable.localObjectId),
      )
      .where(
        and(
          eq(SyncTransferTable.syncGenerationId, this.syncGenerationId),
          eq(SyncTransferTable.direction, 'download'),
          eq(SyncTransferTable.state, 'completed'),
          eq(SyncLocalObjectTable.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async publishBlobs(signal: AbortSignal): Promise<{ objectCount: number }> {
    const rows = await this.db
      .select({
        localObjectId: SyncLocalObjectTable.id,
        objectKind: SyncLocalObjectTable.objectKind,
        logicalKeyId: SyncLocalObjectTable.logicalKeyId,
        storageRef: SyncLocalObjectTable.storageRef,
        storedSha256: SyncLocalObjectTable.storedSha256,
        sizeBytes: SyncLocalObjectTable.sizeBytes,
      })
      .from(SyncBlobStateTable)
      .innerJoin(
        SyncLocalObjectTable,
        eq(SyncLocalObjectTable.id, SyncBlobStateTable.localObjectId),
      )
      .where(
        and(
          eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
          eq(SyncBlobStateTable.localState, 'verified'),
          inArray(SyncBlobStateTable.remoteState, ['missing', 'publishing']),
        ),
      );
    let countPublished = 0;
    for (const row of rows) {
      assertNotAborted(signal);
      await this.publishLocalObject({ ...row, objectKind: 'blob' }, signal);
      await this.db
        .update(SyncBlobStateTable)
        .set({ remoteState: 'available', updatedAt: this.clock.nowIso() })
        .where(
          and(
            eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
            eq(SyncBlobStateTable.localObjectId, row.localObjectId),
          ),
        );
      countPublished += 1;
    }
    return { objectCount: countPublished };
  }

  private async publishSegments(signal: AbortSignal): Promise<{ objectCount: number }> {
    const rows = await this.db
      .select({
        segmentId: SyncSegmentTable.segmentId,
        writerId: SyncSegmentTable.writerId,
        writerEpoch: SyncSegmentTable.writerEpoch,
        firstSeq: SyncSegmentTable.firstSeq,
        lastSeq: SyncSegmentTable.lastSeq,
        requiredBlobIdsCbor: SyncSegmentTable.requiredBlobIdsCbor,
        segmentSha256: SyncSegmentTable.segmentSha256,
        localObjectId: SyncLocalObjectTable.id,
        objectKind: SyncLocalObjectTable.objectKind,
        logicalKeyId: SyncLocalObjectTable.logicalKeyId,
        storageRef: SyncLocalObjectTable.storageRef,
        storedSha256: SyncLocalObjectTable.storedSha256,
        sizeBytes: SyncLocalObjectTable.sizeBytes,
      })
      .from(SyncSegmentTable)
      .innerJoin(
        SyncLocalObjectTable,
        eq(SyncLocalObjectTable.id, SyncSegmentTable.localObjectId),
      )
      .where(
        and(
          eq(SyncSegmentTable.syncGenerationId, this.syncGenerationId),
          inArray(SyncSegmentTable.state, ['sealed', 'publishing']),
        ),
      )
      .orderBy(
        asc(SyncSegmentTable.writerId),
        asc(SyncSegmentTable.writerEpoch),
        asc(SyncSegmentTable.firstSeq),
      );
    let countPublished = 0;
    for (const row of rows) {
      assertNotAborted(signal);
      if (!(await this.requiredBlobsRemoteAvailable(row.requiredBlobIdsCbor))) continue;
      const remote = await this.publishLocalObject(
        { ...row, objectKind: 'segment' },
        signal,
      );
      const frontier = await this.stateRepository.loadWriterFrontier({
        syncGenerationId: this.syncGenerationId,
        writerId: row.writerId,
        writerEpoch: row.writerEpoch,
      });
      const range = { firstSeq: row.firstSeq, lastSeq: row.lastSeq };
      const published = observeFrontierRange(frontier, 'published', range);
      const nowIso = this.clock.nowIso();
      await this.db.transaction(async (tx) => {
        await tx
          .update(SyncSegmentTable)
          .set({ state: 'published', publishedAt: nowIso })
          .where(eq(SyncSegmentTable.segmentId, row.segmentId));
        await tx
          .update(SyncLocalObjectTable)
          .set({ state: 'published' })
          .where(eq(SyncLocalObjectTable.id, row.localObjectId));
        await this.upsertRemoteObject(remote, syncRemoteObjectId(this.syncGenerationId, remote.objectId), nowIso, tx);
        await persistWriterFrontierInTransaction(tx, published, nowIso);
        const terminalPurge = await tx
          .select({ changeSetId: SyncChangeSetTable.changeSetId })
          .from(SyncChangeSetTable)
          .innerJoin(
            SyncMutationTable,
            eq(SyncMutationTable.changeSetId, SyncChangeSetTable.changeSetId),
          )
          .where(
            and(
              eq(SyncChangeSetTable.syncGenerationId, this.syncGenerationId),
              eq(SyncChangeSetTable.writerId, row.writerId),
              eq(SyncChangeSetTable.writerEpoch, row.writerEpoch),
              gte(SyncChangeSetTable.deviceSeq, row.firstSeq),
              lte(SyncChangeSetTable.deviceSeq, row.lastSeq),
              eq(SyncMutationTable.action, 'sync-generation.purge'),
            ),
          )
          .limit(1);
        if (terminalPurge.length > 0) {
          const generation = (await tx
            .select({ projectId: SyncGenerationTable.projectId, status: SyncGenerationTable.status })
            .from(SyncGenerationTable)
            .where(eq(SyncGenerationTable.syncGenerationId, this.syncGenerationId))
            .limit(1))[0];
          if (!generation || generation.status !== 'active' || generation.projectId !== null) {
            throw new Error('sync-generation.purge publication requires a detached active SyncGeneration');
          }
          await tx
            .update(SyncGenerationTable)
            .set({ status: 'purged', purgedAt: nowIso, updatedAt: nowIso })
            .where(eq(SyncGenerationTable.syncGenerationId, this.syncGenerationId));
          await tx
            .update(SyncProviderBindingTable)
            .set({ state: 'purged', updatedAt: nowIso })
            .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId));
        }
      });
      countPublished += 1;
    }
    return { objectCount: countPublished };
  }

  private async requiredBlobsRemoteAvailable(encoded: unknown): Promise<boolean> {
    const ids = decodeRequiredBlobIds(encoded);
    if (ids.length === 0) return true;
    const rows = await this.db
      .select({ blobId: SyncBlobStateTable.blobId })
      .from(SyncBlobStateTable)
      .where(
        and(
          eq(SyncBlobStateTable.syncGenerationId, this.syncGenerationId),
          inArray(SyncBlobStateTable.blobId, [...ids]),
          eq(SyncBlobStateTable.remoteState, 'available'),
        ),
      );
    return new Set(rows.map((row) => row.blobId)).size === ids.length;
  }

  private async publishLocalObject(
    local: PublishableLocalObject,
    signal: AbortSignal,
  ): Promise<RemoteObject> {
    const generation = await this.providerGeneration();
    const storedSha256 = protocolSha256(local.storedSha256);
    const identity = { generation, objectKind: local.objectKind, logicalKeyId: local.logicalKeyId };
    const transferId = await createProviderTransferId({
      direction: 'upload',
      syncGenerationId: this.syncGenerationId,
      objectIdentity: local.logicalKeyId,
    });
    const nowIso = this.clock.nowIso();
    await this.db
      .insert(SyncTransferTable)
      .values({
        transferId,
        syncGenerationId: this.syncGenerationId,
        direction: 'upload',
        objectKind: local.objectKind,
        logicalKeyId: local.logicalKeyId,
        localObjectId: local.localObjectId,
        expectedStoredSha256: local.storedSha256,
        totalBytes: local.sizeBytes,
        transferredBytes: 0,
        state: 'running',
        attemptCount: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: SyncTransferTable.transferId,
        set: {
          state: 'running',
          attemptCount: sql`${SyncTransferTable.attemptCount} + 1`,
          updatedAt: nowIso,
          lastErrorCode: null,
          nextAttemptAt: null,
        },
      });
    try {
      assertNotAborted(signal);
      const existing = await this.provider.statImmutable(identity);
      if (existing) {
        if (existing.storedSha256 !== storedSha256 || existing.sizeBytes !== local.sizeBytes) {
          throw new Error(`provider immutable key ${local.logicalKeyId} has conflicting bytes`);
        }
        await this.completeUploadReceipt(local, transferId, existing);
        return existing;
      }
      const result = await this.provider.uploadImmutable({
        generation,
        sourceRef: createLocalObjectRef(local.storageRef),
        objectKind: local.objectKind,
        logicalKeyId: local.logicalKeyId,
        storedSha256,
        sizeBytes: local.sizeBytes,
        transferId,
        signal,
      });
      await this.completeUploadReceipt(local, transferId, result.object);
      return result.object;
    } catch (error) {
      const failedAt = this.clock.nowIso();
      await this.db
        .update(SyncTransferTable)
        .set({
          state: 'retry-wait',
          updatedAt: failedAt,
          lastErrorCode:
            typeof error === 'object' && error && 'code' in error
              ? String((error as { code: unknown }).code)
              : 'UPLOAD_FAILED',
          nextAttemptAt: failedAt,
        })
        .where(eq(SyncTransferTable.transferId, transferId));
      throw error;
    }
  }

  private async completeUploadReceipt(
    local: PublishableLocalObject,
    transferId: string,
    remote: RemoteObject,
  ): Promise<void> {
    const remoteId = syncRemoteObjectId(this.syncGenerationId, remote.objectId);
    const completedAt = this.clock.nowIso();
    await this.db.transaction(async (tx) => {
      await this.upsertRemoteObject(remote, remoteId, completedAt, tx);
      await tx
        .update(SyncTransferTable)
        .set({
          remoteObjectId: remoteId,
          state: 'completed',
          transferredBytes: local.sizeBytes,
          updatedAt: completedAt,
          completedAt,
          lastErrorCode: null,
          nextAttemptAt: null,
        })
        .where(eq(SyncTransferTable.transferId, transferId));
    });
  }

  private async quarantineDownloaded(
    row: DownloadedSegmentRow,
    reason: string,
    state: 'blocked-update' | 'blocked-corrupt',
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(SyncLocalObjectTable)
        .set({ state: 'quarantined' })
        .where(eq(SyncLocalObjectTable.id, row.localObjectId));
      await this.insertQuarantine(tx, {
        remoteId: row.remoteId,
        localObjectId: row.localObjectId,
        reason,
        storedSha256: protocolSha256(row.storedSha256),
        sizeBytes: row.sizeBytes,
        state,
      });
    });
  }

  private async insertQuarantine(
    tx: DbTransaction,
    input: {
      remoteId: string;
      localObjectId: string;
      reason: string;
      storedSha256: Sha256;
      sizeBytes: number;
      state: 'blocked-update' | 'blocked-corrupt';
    },
  ): Promise<void> {
    const nowIso = this.clock.nowIso();
    await tx
      .insert(SyncQuarantinedObjectTable)
      .values({
        quarantineId: opaqueId(['quarantine', this.syncGenerationId, input.localObjectId]),
        syncGenerationId: this.syncGenerationId,
        remoteObjectId: input.remoteId,
        localObjectId: input.localObjectId,
        reason: input.reason.slice(0, 512),
        observedProtocol: 'drifting.sync.segment',
        observedVersion: null,
        storedSha256: sha256Hex(input.storedSha256),
        sizeBytes: input.sizeBytes,
        state: input.state,
        createdAt: nowIso,
      })
      .onConflictDoUpdate({
        target: SyncQuarantinedObjectTable.localObjectId,
        set: { reason: input.reason.slice(0, 512), state: input.state },
      });
    await tx
      .update(SyncProviderBindingTable)
      .set({ state: input.state, updatedAt: nowIso })
      .where(eq(SyncProviderBindingTable.syncGenerationId, this.syncGenerationId));
  }
}
