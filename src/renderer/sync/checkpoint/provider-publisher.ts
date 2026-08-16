import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { DbClient, DbTransaction } from '../../lib/db';
import {
  SyncBlobStateTable,
  SyncChangeSetTable,
  SyncCheckpointTable,
  SyncConflictTable,
  SyncFrontierGapTable,
  SyncLocalObjectTable,
  SyncProviderBindingTable,
  SyncQuarantinedObjectTable,
  SyncRemoteObjectTable,
  SyncSegmentTable,
  SyncTransferTable,
  SyncGenerationTable,
} from '../../schema/drizzle';
import type { SyncEngineBlobPort } from '../engine';
import type { SyncEngineObjectCodec } from '../engine/object-codec';
import {
  createLocalObjectRef,
  encodeCanonicalCbor,
  encodeSnapshotCommitMarkerV1,
  sha256Bytes,
  type ObjectLogProvider,
  type ProviderGeneration,
  type RemoteObject,
  type Sha256,
  type SnapshotKind,
  type SyncObjectKind,
} from '../protocol';
import { captureSnapshotV1 } from './capture';
import type { SnapshotAssetCapturePort } from './types';

const DEFAULT_CHANGE_SET_THRESHOLD = 10_000;
const DEFAULT_SEGMENT_BYTE_THRESHOLD = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

function sha256Hex(value: Sha256): string {
  return value.slice('sha256:'.length);
}

function protocolSha256(value: string): Sha256 {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('Persisted SHA-256 is malformed');
  return `sha256:${value}`;
}

function requireObjectKind(value: string): SyncObjectKind {
  if (
    value !== 'segment' &&
    value !== 'genesis' &&
    value !== 'checkpoint' &&
    value !== 'snapshot-commit' &&
    value !== 'blob'
  ) {
    throw new Error(`Unsupported immutable object kind ${value}`);
  }
  return value;
}

function localPackageId(syncGenerationId: string, snapshotId: string): string {
  return JSON.stringify(['snapshot-package', syncGenerationId, snapshotId]);
}

function localMarkerId(syncGenerationId: string, snapshotId: string): string {
  return JSON.stringify(['snapshot-marker', syncGenerationId, snapshotId]);
}

function localBlobId(syncGenerationId: string, blobId: string): string {
  return JSON.stringify(['snapshot-blob', syncGenerationId, blobId]);
}

function remoteObjectId(syncGenerationId: string, providerObjectId: string): string {
  return JSON.stringify(['provider-object', syncGenerationId, providerObjectId]);
}

async function transferId(syncGenerationId: string, logicalKeyId: string): Promise<string> {
  const digest = await sha256Bytes(
    new TextEncoder().encode(`upload\0${syncGenerationId}\0${logicalKeyId}`),
  );
  return `upload-${sha256Hex(digest)}`;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error) {
    return String((error as { code: unknown }).code).slice(0, 128);
  }
  return 'UPLOAD_FAILED';
}

interface DurableLocalObject {
  readonly id: string;
  readonly syncGenerationId: string;
  readonly objectKind: SyncObjectKind;
  readonly logicalKeyId: string;
  readonly storageRef: string;
  readonly storedSha256: string;
  readonly contentSha256: string | null;
  readonly sizeBytes: number;
  readonly state: string;
}

export interface PublishedImmutableObject {
  readonly localObjectId: string;
  readonly remoteObjectId: string;
  readonly remoteObject: RemoteObject;
}

/**
 * Durable provider-neutral immutable upload lane.
 *
 * SQLite owns the intent/receipt; provider calls happen strictly outside a
 * transaction. A lost upload response is reconciled by statting the same
 * logical key and accepting only identical immutable metadata.
 */
export class DurableImmutableObjectPublisher {
  constructor(
    private readonly db: DbClient,
    private readonly provider: ObjectLogProvider,
    private readonly generation: ProviderGeneration,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  async publish(localObjectId: string, signal: AbortSignal): Promise<PublishedImmutableObject> {
    const [row] = await this.db
      .select()
      .from(SyncLocalObjectTable)
      .where(eq(SyncLocalObjectTable.id, localObjectId))
      .limit(1);
    if (!row || row.syncGenerationId !== this.generation.syncGenerationId) {
      throw new Error('Immutable upload local object is missing or belongs to another SyncGeneration');
    }
    const local: DurableLocalObject = {
      ...row,
      objectKind: requireObjectKind(row.objectKind),
    };
    if (!['verified', 'publishing', 'published'].includes(local.state)) {
      throw new Error('Immutable upload requires a verified durable local object');
    }
    const id = await transferId(local.syncGenerationId, local.logicalKeyId);
    const startedAt = this.nowIso();
    await this.db.transaction(async (tx) => {
      await tx
        .update(SyncLocalObjectTable)
        .set({ state: 'publishing' })
        .where(eq(SyncLocalObjectTable.id, local.id));
      await tx
        .insert(SyncTransferTable)
        .values({
          transferId: id,
          syncGenerationId: local.syncGenerationId,
          direction: 'upload',
          objectKind: local.objectKind,
          logicalKeyId: local.logicalKeyId,
          localObjectId: local.id,
          expectedStoredSha256: local.storedSha256,
          totalBytes: local.sizeBytes,
          transferredBytes: 0,
          state: 'running',
          attemptCount: 1,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .onConflictDoUpdate({
          target: SyncTransferTable.transferId,
          set: {
            state: 'running',
            attemptCount: sql`${SyncTransferTable.attemptCount} + 1`,
            updatedAt: startedAt,
            completedAt: null,
            lastErrorCode: null,
            nextAttemptAt: null,
          },
        });
    });

    try {
      if (signal.aborted) throw new DOMException('Sync upload aborted', 'AbortError');
      const storedSha256 = protocolSha256(local.storedSha256);
      let remote = await this.provider.statImmutable({
        generation: this.generation,
        objectKind: local.objectKind,
        logicalKeyId: local.logicalKeyId,
      });
      if (!remote) {
        remote = (
          await this.provider.uploadImmutable({
            generation: this.generation,
            sourceRef: createLocalObjectRef(local.storageRef),
            objectKind: local.objectKind,
            logicalKeyId: local.logicalKeyId,
            storedSha256,
            sizeBytes: local.sizeBytes,
            transferId: id,
            signal,
          })
        ).object;
      }
      if (
        remote.logicalKeyId !== local.logicalKeyId ||
        remote.objectKind !== local.objectKind ||
        remote.storedSha256 !== storedSha256 ||
        remote.sizeBytes !== local.sizeBytes
      ) {
        throw new Error('Provider logical key contains conflicting immutable bytes');
      }
      const internalRemoteId = remoteObjectId(local.syncGenerationId, remote.objectId);
      const completedAt = this.nowIso();
      await this.db.transaction(async (tx) => {
        await this.recordRemoteObject(tx, local, remote!, internalRemoteId, completedAt);
        await tx
          .update(SyncTransferTable)
          .set({
            remoteObjectId: internalRemoteId,
            state: 'completed',
            transferredBytes: local.sizeBytes,
            completedAt,
            updatedAt: completedAt,
            lastErrorCode: null,
            nextAttemptAt: null,
          })
          .where(eq(SyncTransferTable.transferId, id));
        await tx
          .update(SyncLocalObjectTable)
          .set({ state: 'published' })
          .where(eq(SyncLocalObjectTable.id, local.id));
        if (local.objectKind === 'blob') {
          await tx
            .update(SyncBlobStateTable)
            .set({ remoteState: 'available', updatedAt: completedAt })
            .where(
              and(
                eq(SyncBlobStateTable.syncGenerationId, local.syncGenerationId),
                eq(SyncBlobStateTable.localObjectId, local.id),
              ),
            );
        }
      });
      return { localObjectId: local.id, remoteObjectId: internalRemoteId, remoteObject: remote };
    } catch (error) {
      const failedAt = this.nowIso();
      await this.db
        .update(SyncTransferTable)
        .set({
          state: 'retry-wait',
          lastErrorCode: errorCode(error),
          nextAttemptAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(SyncTransferTable.transferId, id));
      throw error;
    }
  }

  private async recordRemoteObject(
    tx: DbTransaction,
    local: DurableLocalObject,
    remote: RemoteObject,
    id: string,
    nowIso: string,
  ): Promise<void> {
    const [existing] = await tx
      .select()
      .from(SyncRemoteObjectTable)
      .where(
        and(
          eq(SyncRemoteObjectTable.syncGenerationId, local.syncGenerationId),
          eq(SyncRemoteObjectTable.providerObjectId, remote.objectId),
        ),
      )
      .limit(1);
    if (
      existing &&
      (existing.logicalKeyId !== remote.logicalKeyId ||
        existing.objectKind !== remote.objectKind ||
        existing.storedSha256 !== sha256Hex(remote.storedSha256) ||
        existing.sizeBytes !== remote.sizeBytes)
    ) {
      throw new Error('Provider object identity changed after its first durable observation');
    }
    await tx
      .insert(SyncRemoteObjectTable)
      .values({
        id,
        syncGenerationId: local.syncGenerationId,
        providerObjectId: remote.objectId,
        logicalKeyId: remote.logicalKeyId,
        objectKind: remote.objectKind,
        storedSha256: sha256Hex(remote.storedSha256),
        sizeBytes: remote.sizeBytes,
        firstObservedAt: existing?.firstObservedAt ?? nowIso,
        lastObservedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [SyncRemoteObjectTable.syncGenerationId, SyncRemoteObjectTable.providerObjectId],
        set: { lastObservedAt: nowIso, removedAt: null },
      });
  }
}

export interface ProviderSnapshotPublisherOptions {
  readonly db: DbClient;
  readonly projectId: string;
  readonly syncGenerationId: string;
  readonly provider: ObjectLogProvider;
  readonly providerGeneration: ProviderGeneration;
  readonly objectCodec: SyncEngineObjectCodec;
  readonly blobPort: SyncEngineBlobPort;
  readonly assetCapturePort: SnapshotAssetCapturePort;
  readonly flushLocalDurability?: () => Promise<void>;
  readonly nowMs?: () => number;
  readonly nowIso?: () => string;
}

export interface PublishedProviderSnapshot {
  readonly snapshotId: string;
  readonly snapshotKind: SnapshotKind;
  readonly checkpointId: string;
  readonly packageRemoteObjectId: string;
  readonly commitMarkerRemoteObjectId: string;
}

/** Captures and publishes one genesis/checkpoint with marker-last visibility. */
export class ProviderSnapshotPublisher {
  private readonly objectPublisher: DurableImmutableObjectPublisher;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;

  constructor(private readonly options: ProviderSnapshotPublisherOptions) {
    if (options.providerGeneration.syncGenerationId !== options.syncGenerationId) {
      throw new Error('Snapshot publisher provider SyncGeneration identity mismatch');
    }
    this.nowMs = options.nowMs ?? Date.now;
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.objectPublisher = new DurableImmutableObjectPublisher(
      options.db,
      options.provider,
      options.providerGeneration,
      this.nowIso,
    );
  }

  async publishSnapshot(input: {
    snapshotId: string;
    snapshotKind: SnapshotKind;
    signal: AbortSignal;
    onCaptured?: () => Promise<void>;
  }): Promise<PublishedProviderSnapshot> {
    await this.ensureCaptured(input.snapshotId, input.snapshotKind);
    await input.onCaptured?.();
    const packageId = localPackageId(this.options.syncGenerationId, input.snapshotId);
    const markerId = localMarkerId(this.options.syncGenerationId, input.snapshotId);
    const blobs = await this.options.db
      .select({ localObjectId: SyncBlobStateTable.localObjectId })
      .from(SyncBlobStateTable)
      .where(
        and(
          eq(SyncBlobStateTable.syncGenerationId, this.options.syncGenerationId),
          inArray(SyncBlobStateTable.localState, ['verified']),
        ),
      );
    const blobIds = [...new Set(
      blobs
        .map(({ localObjectId }) => localObjectId)
        .filter((value): value is string => value !== null),
    )].sort();
    for (const blobId of blobIds) await this.objectPublisher.publish(blobId, input.signal);
    await this.options.db
      .update(SyncCheckpointTable)
      .set({ state: 'publishing' })
      .where(eq(SyncCheckpointTable.checkpointId, input.snapshotId));
    const packageResult = await this.objectPublisher.publish(packageId, input.signal);
    const markerResult = await this.objectPublisher.publish(markerId, input.signal);
    const publishedAt = this.nowIso();
    await this.options.db
      .update(SyncCheckpointTable)
      .set({ state: 'published', publishedAt })
      .where(eq(SyncCheckpointTable.checkpointId, input.snapshotId));
    return {
      snapshotId: input.snapshotId,
      snapshotKind: input.snapshotKind,
      checkpointId: input.snapshotId,
      packageRemoteObjectId: packageResult.remoteObjectId,
      commitMarkerRemoteObjectId: markerResult.remoteObjectId,
    };
  }

  private async ensureCaptured(snapshotId: string, snapshotKind: SnapshotKind): Promise<void> {
    const [existing] = await this.options.db
      .select()
      .from(SyncCheckpointTable)
      .where(eq(SyncCheckpointTable.checkpointId, snapshotId))
      .limit(1);
    if (existing) {
      if (
        existing.syncGenerationId !== this.options.syncGenerationId ||
        existing.kind !== snapshotKind ||
        !existing.logicalKeyId
      ) {
        throw new Error('Snapshot identity collides with another durable checkpoint');
      }
      const localIds = [
        existing.localObjectId,
        localMarkerId(this.options.syncGenerationId, snapshotId),
      ];
      const locals = await this.options.db
        .select({ id: SyncLocalObjectTable.id })
        .from(SyncLocalObjectTable)
        .where(inArray(SyncLocalObjectTable.id, localIds));
      if (new Set(locals.map(({ id }) => id)).size !== 2) {
        throw new Error('Durable snapshot is missing its package or commit marker');
      }
      return;
    }

    await this.options.flushLocalDurability?.();
    const capturedMs = this.nowMs();
    const captured = await captureSnapshotV1({
      db: this.options.db,
      projectId: this.options.projectId,
      syncGenerationId: this.options.syncGenerationId,
      snapshotId,
      snapshotKind,
      packageLogicalKeyId: 'pending-package-logical-key',
      capturedAt: { wallMs: capturedMs, counter: 0 },
      committedAt: { wallMs: capturedMs, counter: 1 },
      assetPort: this.options.assetCapturePort,
    });
    const packagePrepared = await this.options.objectCodec.prepareOutbound({
      syncGenerationId: this.options.syncGenerationId,
      objectKind: snapshotKind,
      canonicalLogicalKey: `snapshot/${this.options.syncGenerationId}/${snapshotKind}/${snapshotId}/package`,
      protocolBytes: captured.packageBytes,
    });
    if (packagePrepared.contentSha256 !== captured.packageSha256) {
      throw new Error('Staged snapshot package changed canonical bytes');
    }
    const commitMarker = {
      ...captured.commitMarker,
      packageLogicalKeyId: packagePrepared.logicalKeyId,
    };
    const markerBytes = encodeSnapshotCommitMarkerV1(commitMarker);
    const markerPrepared = await this.options.objectCodec.prepareOutbound({
      syncGenerationId: this.options.syncGenerationId,
      objectKind: 'snapshot-commit',
      canonicalLogicalKey: `snapshot/${this.options.syncGenerationId}/${snapshotKind}/${snapshotId}/commit`,
      protocolBytes: markerBytes,
    });
    if (markerPrepared.contentSha256 !== await sha256Bytes(markerBytes)) {
      throw new Error('Staged snapshot marker changed canonical bytes');
    }

    const capturedByBlob = new Map<string, (typeof captured.assets)[number]>();
    for (const asset of captured.assets) capturedByBlob.set(asset.asset.blobId, asset);
    const preparedBlobs = [] as Array<{
      blobId: Sha256;
      assetId: string;
      mime: string;
      sizeBytes: number;
      prepared: Awaited<ReturnType<SyncEngineBlobPort['prepareOutbound']>>;
    }>;
    for (const capturedAsset of capturedByBlob.values()) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(capturedAsset.asset.blobId)) {
        throw new Error('Snapshot asset blob identity is not content-addressed');
      }
      const blobId = capturedAsset.asset.blobId as Sha256;
      const [durable] = await this.options.db
        .select()
        .from(SyncBlobStateTable)
        .where(
          and(
            eq(SyncBlobStateTable.syncGenerationId, this.options.syncGenerationId),
            eq(SyncBlobStateTable.blobId, blobId),
          ),
        )
        .limit(1);
      if (durable) {
        if (
          durable.contentSha256 !== sha256Hex(capturedAsset.asset.sourceSha256) ||
          durable.sizeBytes !== capturedAsset.asset.sizeBytes ||
          durable.localState !== 'verified'
        ) {
          throw new Error('Existing snapshot blob receipt conflicts with canonical asset bytes');
        }
        // A restored asset can intentionally retain only its verified
        // canonical source plus the already-available remote object. If the
        // remote copy is not known available, fall through and prepare a new
        // local immutable receipt.
        if (durable.localObjectId || durable.remoteState === 'available') continue;
      }
      const prepared = await this.options.blobPort.prepareOutbound({
        syncGenerationId: this.options.syncGenerationId,
        projectId: this.options.projectId,
        declaration: {
          assetId: capturedAsset.asset.assetId,
          blobId,
          sourceSha256: capturedAsset.asset.sourceSha256,
          sourceSizeBytes: capturedAsset.asset.sizeBytes,
          sourceMime: capturedAsset.asset.mimeType,
        },
      });
      if (prepared.contentSha256 !== capturedAsset.asset.sourceSha256) {
        throw new Error('Staged snapshot blob changed canonical source bytes');
      }
      preparedBlobs.push({
        blobId,
        assetId: capturedAsset.asset.assetId,
        mime: capturedAsset.asset.mimeType,
        sizeBytes: capturedAsset.asset.sizeBytes,
        prepared,
      });
    }

    const changeSetRows = await this.options.db
      .select({ changeSetId: SyncChangeSetTable.changeSetId })
      .from(SyncChangeSetTable)
      .where(eq(SyncChangeSetTable.syncGenerationId, this.options.syncGenerationId));
    const nowIso = this.nowIso();
    await this.options.db.transaction(async (tx) => {
      const [collision] = await tx
        .select({ checkpointId: SyncCheckpointTable.checkpointId })
        .from(SyncCheckpointTable)
        .where(eq(SyncCheckpointTable.checkpointId, snapshotId))
        .limit(1);
      if (collision) throw new Error('Concurrent snapshot capture used the same identity');
      await tx.insert(SyncLocalObjectTable).values([
        {
          id: localPackageId(this.options.syncGenerationId, snapshotId),
          syncGenerationId: this.options.syncGenerationId,
          objectKind: snapshotKind,
          logicalKeyId: packagePrepared.logicalKeyId,
          storageRef: packagePrepared.sourceRef,
          storedSha256: sha256Hex(packagePrepared.storedSha256),
          contentSha256: sha256Hex(packagePrepared.contentSha256),
          sizeBytes: packagePrepared.sizeBytes,
          codec: packagePrepared.codec,
          state: 'verified',
          createdAt: nowIso,
          verifiedAt: nowIso,
        },
        {
          id: localMarkerId(this.options.syncGenerationId, snapshotId),
          syncGenerationId: this.options.syncGenerationId,
          objectKind: 'snapshot-commit',
          logicalKeyId: markerPrepared.logicalKeyId,
          storageRef: markerPrepared.sourceRef,
          storedSha256: sha256Hex(markerPrepared.storedSha256),
          contentSha256: sha256Hex(markerPrepared.contentSha256),
          sizeBytes: markerPrepared.sizeBytes,
          codec: markerPrepared.codec,
          state: 'verified',
          createdAt: nowIso,
          verifiedAt: nowIso,
        },
      ]);
      for (const blob of preparedBlobs) {
        const id = localBlobId(this.options.syncGenerationId, blob.blobId);
        await tx.insert(SyncLocalObjectTable).values({
          id,
          syncGenerationId: this.options.syncGenerationId,
          objectKind: 'blob',
          logicalKeyId: blob.prepared.logicalKeyId,
          storageRef: blob.prepared.sourceRef,
          storedSha256: sha256Hex(blob.prepared.storedSha256),
          contentSha256: sha256Hex(blob.prepared.contentSha256),
          sizeBytes: blob.prepared.sizeBytes,
          codec: 'raw',
          state: 'verified',
          createdAt: nowIso,
          verifiedAt: nowIso,
        });
        await tx.insert(SyncBlobStateTable).values({
          syncGenerationId: this.options.syncGenerationId,
          blobId: blob.blobId,
          assetId: blob.assetId,
          logicalKeyId: blob.prepared.logicalKeyId,
          contentSha256: sha256Hex(blob.prepared.contentSha256),
          sizeBytes: blob.sizeBytes,
          mime: blob.mime,
          localObjectId: id,
          localState: 'verified',
          remoteState: 'missing',
          verifiedAt: nowIso,
          updatedAt: nowIso,
        }).onConflictDoUpdate({
          target: [SyncBlobStateTable.syncGenerationId, SyncBlobStateTable.blobId],
          set: {
            assetId: blob.assetId,
            logicalKeyId: blob.prepared.logicalKeyId,
            contentSha256: sha256Hex(blob.prepared.contentSha256),
            sizeBytes: blob.sizeBytes,
            mime: blob.mime,
            localObjectId: id,
            localState: 'verified',
            remoteState: 'missing',
            verifiedAt: nowIso,
            updatedAt: nowIso,
          },
        });
      }
      await tx.insert(SyncCheckpointTable).values({
        checkpointId: snapshotId,
        syncGenerationId: this.options.syncGenerationId,
        kind: snapshotKind,
        protocolVersion: 1,
        domainSchemaVersion: 1,
        frontierCbor: encodeCanonicalCbor(captured.package.frontier),
        localObjectId: localPackageId(this.options.syncGenerationId, snapshotId),
        logicalKeyId: packagePrepared.logicalKeyId,
        contentSha256: sha256Hex(captured.packageSha256),
        state: 'captured',
        changeSetCount: changeSetRows.length,
        sizeBytes: captured.packageBytes.byteLength,
        createdAt: nowIso,
        verifiedAt: nowIso,
      });
    });
  }
}

export interface ProviderCheckpointHookOptions {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly publisher: ProviderSnapshotPublisher;
  readonly createSnapshotId?: () => string;
  readonly nowMs?: () => number;
  readonly changeSetThreshold?: number;
  readonly segmentByteThreshold?: number;
  readonly maxAgeMs?: number;
}

/** Reusable `SqliteSyncGenerationRuntime.checkpoint` hook with the frozen v1 policy. */
export function createProviderCheckpointHook(options: ProviderCheckpointHookOptions): {
  captureIfDue(input: { syncGenerationId: string; signal: AbortSignal }): Promise<boolean>;
} {
  const createSnapshotId = options.createSnapshotId ?? (() => `checkpoint-${uuidv7()}`);
  const nowMs = options.nowMs ?? Date.now;
  return {
    async captureIfDue({ syncGenerationId, signal }) {
      if (syncGenerationId !== options.syncGenerationId) throw new Error('Checkpoint hook SyncGeneration identity mismatch');
      const [generation] = await options.db
        .select({ status: SyncGenerationTable.status, projectId: SyncGenerationTable.projectId })
        .from(SyncGenerationTable)
        .where(eq(SyncGenerationTable.syncGenerationId, syncGenerationId))
        .limit(1);
      if (!generation || generation.status !== 'active' || generation.projectId === null) return false;
      const [binding, removedRemote, gaps, conflicts, quarantined] = await Promise.all([
        options.db
          .select({ state: SyncProviderBindingTable.state })
          .from(SyncProviderBindingTable)
          .where(eq(SyncProviderBindingTable.syncGenerationId, syncGenerationId))
          .limit(1),
        options.db
          .select({ id: SyncRemoteObjectTable.id })
          .from(SyncRemoteObjectTable)
          .where(
            and(
              eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
              isNotNull(SyncRemoteObjectTable.removedAt),
            ),
          )
          .limit(1),
        options.db
          .select({ id: SyncFrontierGapTable.id })
          .from(SyncFrontierGapTable)
          .where(
            and(
              eq(SyncFrontierGapTable.syncGenerationId, syncGenerationId),
              eq(SyncFrontierGapTable.state, 'open'),
            ),
          )
          .limit(1),
        options.db
          .select({ id: SyncConflictTable.conflictId })
          .from(SyncConflictTable)
          .where(
            and(
              eq(SyncConflictTable.syncGenerationId, syncGenerationId),
              eq(SyncConflictTable.state, 'open'),
            ),
          )
          .limit(1),
        options.db
          .select({ id: SyncQuarantinedObjectTable.quarantineId })
          .from(SyncQuarantinedObjectTable)
          .where(
            and(
              eq(SyncQuarantinedObjectTable.syncGenerationId, syncGenerationId),
              inArray(SyncQuarantinedObjectTable.state, [
                'blocked-update',
                'blocked-corrupt',
              ]),
            ),
          )
          .limit(1),
      ]);
      if (
        binding[0]?.state !== 'ready' ||
        removedRemote.length > 0 ||
        gaps.length > 0 ||
        conflicts.length > 0 ||
        quarantined.length > 0
      ) return false;
      const [latest] = await options.db
        .select()
        .from(SyncCheckpointTable)
        .where(eq(SyncCheckpointTable.syncGenerationId, syncGenerationId))
        .orderBy(desc(SyncCheckpointTable.createdAt))
        .limit(1);
      const changeSets = await options.db
        .select({ id: SyncChangeSetTable.changeSetId })
        .from(SyncChangeSetTable)
        .where(eq(SyncChangeSetTable.syncGenerationId, syncGenerationId));
      const currentCount = changeSets.length;
      const previousCount = latest?.changeSetCount ?? 0;
      if (currentCount <= previousCount) return false;
      const segments = await options.db
        .select({ createdAt: SyncSegmentTable.createdAt, sizeBytes: SyncLocalObjectTable.sizeBytes })
        .from(SyncSegmentTable)
        .innerJoin(
          SyncLocalObjectTable,
          eq(SyncSegmentTable.localObjectId, SyncLocalObjectTable.id),
        )
        .where(eq(SyncSegmentTable.syncGenerationId, syncGenerationId));
      const bytesSince = segments
        .filter(({ createdAt }) => !latest || createdAt > latest.createdAt)
        .reduce((total, { sizeBytes }) => total + sizeBytes, 0);
      const ageMs = latest ? nowMs() - Date.parse(latest.createdAt) : Number.POSITIVE_INFINITY;
      const due =
        currentCount - previousCount >=
          (options.changeSetThreshold ?? DEFAULT_CHANGE_SET_THRESHOLD) ||
        bytesSince >= (options.segmentByteThreshold ?? DEFAULT_SEGMENT_BYTE_THRESHOLD) ||
        ageMs >= (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
      if (!due) return false;
      await options.publisher.publishSnapshot({
        snapshotId: createSnapshotId(),
        snapshotKind: 'checkpoint',
        signal,
      });
      return true;
    },
  };
}
