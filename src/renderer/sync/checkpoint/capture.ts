import { and, asc, eq, inArray } from 'drizzle-orm';
import * as Y from 'yjs';

import type { DbExecutor } from '../../lib/db';
import {
  SyncConflictTable,
  SyncFrontierGapTable,
  SyncFrontierTable,
  SyncQuarantinedObjectTable,
  SyncGenerationTable,
  yjsSnapshots,
  yjsUpdates,
} from '../../schema/drizzle';
import {
  compareUtf8Bytewise,
  encodeCanonicalCbor,
  encodeSnapshotCommitMarkerV1,
  encodeSnapshotPackageV1,
  hashCanonicalCbor,
  sha256Bytes,
  type CanonicalCborValue,
  type Hlc,
  type Sha256,
  type SnapshotKind,
  type SnapshotPackageV1,
} from '../protocol';
import {
  assertNormalizedAuthoredAuthorityV1,
  captureAuthoredTablesV1,
  proseSeedRows,
} from './domain-catalog';
import { captureReducerStateV1 } from './reducer-state';
import {
  AUTHORED_STATE_FORMAT_V1,
  type AuthoredStatePayloadV1,
  type CapturedAssetSourceV1,
  type CapturedSnapshotV1,
  type SnapshotAssetCapturePort,
} from './types';

export interface CaptureSnapshotInputV1 {
  readonly db: DbExecutor;
  readonly projectId: string;
  readonly syncGenerationId: string;
  readonly snapshotId: string;
  readonly snapshotKind: SnapshotKind;
  readonly packageLogicalKeyId: string;
  readonly capturedAt: Hlc;
  readonly committedAt: Hlc;
  readonly assetPort?: SnapshotAssetCapturePort;
  readonly sqliteSchemaVersion?: 1;
}

function protocolSha256(raw: string): Sha256 {
  if (!/^[0-9a-f]{64}$/u.test(raw)) throw new Error('Persisted SHA-256 is malformed');
  return `sha256:${raw}`;
}

function normalizeBlob(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  const buffer = value as { type?: string; data?: number[] } | null;
  if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) return Uint8Array.from(buffer.data);
  throw new Error('Snapshot capture encountered an unsupported SQLite blob');
}

async function captureProseDocuments(
  tx: DbExecutor,
  authored: readonly import('./types').SnapshotTableRowsV1[],
): Promise<readonly SnapshotPackageV1['proseDocuments'][number][]> {
  const seeds = proseSeedRows(authored);
  const docIds = [...seeds.keys()].sort(compareUtf8Bytewise);
  const snapshots = docIds.length === 0
    ? []
    : await tx
        .select()
        .from(yjsSnapshots)
        .where(inArray(yjsSnapshots.docId, docIds))
        .orderBy(asc(yjsSnapshots.docId));
  const updates = docIds.length === 0
    ? []
    : await tx
        .select()
        .from(yjsUpdates)
        .where(inArray(yjsUpdates.docId, docIds))
        .orderBy(asc(yjsUpdates.docId), asc(yjsUpdates.id));
  const snapshotByDoc = new Map(snapshots.map((row) => [row.docId, normalizeBlob(row.stateBlob)]));
  const updatesByDoc = new Map<string, Uint8Array[]>();
  for (const row of updates) {
    const list = updatesByDoc.get(row.docId) ?? [];
    list.push(normalizeBlob(row.updateBlob));
    updatesByDoc.set(row.docId, list);
  }

  const documents: SnapshotPackageV1['proseDocuments'] = [];
  for (const documentId of docIds) {
    const snapshot = snapshotByDoc.get(documentId);
    const documentUpdates = updatesByDoc.get(documentId) ?? [];
    if (!snapshot && documentUpdates.length === 0) {
      const seed = seeds.get(documentId);
      if (seed === undefined) throw new Error(`Missing seed for ${documentId}`);
      documents.push({
        documentId,
        mode: 'seed-only',
        payloadVersion: 1,
        seed,
        seedSha256: await hashCanonicalCbor(seed),
      });
      continue;
    }
    const ydoc = new Y.Doc();
    try {
      if (snapshot) Y.applyUpdate(ydoc, snapshot, 'sync-checkpoint:snapshot');
      for (const update of documentUpdates) {
        Y.applyUpdate(ydoc, update, 'sync-checkpoint:update');
      }
    } catch (error) {
      throw new Error(
        `Invalid Yjs state while capturing ${documentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const state = Y.encodeStateAsUpdate(ydoc);
    documents.push({
      documentId,
      mode: 'full-state',
      state,
      stateSha256: await sha256Bytes(state),
    });
    ydoc.destroy();
  }
  return documents;
}

async function assertCaptureIsSafe(tx: DbExecutor, syncGenerationId: string): Promise<void> {
  const [gaps, conflicts, quarantine] = await Promise.all([
    tx
      .select({ id: SyncFrontierGapTable.id })
      .from(SyncFrontierGapTable)
      .where(and(eq(SyncFrontierGapTable.syncGenerationId, syncGenerationId), eq(SyncFrontierGapTable.state, 'open')))
      .limit(1),
    tx
      .select({ id: SyncConflictTable.conflictId })
      .from(SyncConflictTable)
      .where(and(eq(SyncConflictTable.syncGenerationId, syncGenerationId), eq(SyncConflictTable.state, 'open')))
      .limit(1),
    tx
      .select({ id: SyncQuarantinedObjectTable.quarantineId })
      .from(SyncQuarantinedObjectTable)
      .where(
        and(
          eq(SyncQuarantinedObjectTable.syncGenerationId, syncGenerationId),
          inArray(SyncQuarantinedObjectTable.state, ['blocked-update', 'blocked-corrupt']),
        ),
      )
      .limit(1),
  ]);
  if (gaps.length) throw new Error('Cannot capture a snapshot while the applied frontier has gaps');
  if (conflicts.length) throw new Error('Cannot capture a snapshot while conflicts are unresolved');
  if (quarantine.length) throw new Error('Cannot capture a snapshot while objects are quarantined');
}

interface ReadCapture {
  readonly projectId: string;
  readonly projectSyncId: string;
  readonly syncGenerationId: string;
  readonly authored: AuthoredStatePayloadV1;
  readonly reducer: Awaited<ReturnType<typeof captureReducerStateV1>>;
  readonly prose: readonly SnapshotPackageV1['proseDocuments'][number][];
  readonly frontier: readonly {
    writerId: string;
    writerEpoch: string;
    appliedSeq: number;
    segmentHeadHash: Sha256 | null;
  }[];
}

async function readConsistentCapture(input: CaptureSnapshotInputV1): Promise<ReadCapture> {
  return input.db.transaction(async (tx) => {
    const generations = await tx
      .select()
      .from(SyncGenerationTable)
      .where(eq(SyncGenerationTable.syncGenerationId, input.syncGenerationId))
      .limit(1);
    const generation = generations[0];
    if (!generation || generation.projectId !== input.projectId || generation.status !== 'active') {
      throw new Error('Snapshot capture requires the active SyncGeneration bound to the requested project');
    }
    if (generation.protocolVersion !== 1 || generation.domainSchemaVersion !== 1) {
      throw new Error('Snapshot capture supports only the current protocol and domain schema');
    }
    await assertCaptureIsSafe(tx, input.syncGenerationId);
    await assertNormalizedAuthoredAuthorityV1(tx, {
      projectId: input.projectId,
      syncGenerationId: input.syncGenerationId,
    });
    const authoredTables = await captureAuthoredTablesV1(tx, input.projectId);
    const authored: AuthoredStatePayloadV1 = {
      format: AUTHORED_STATE_FORMAT_V1,
      payloadVersion: 1,
      tables: authoredTables,
    };
    const reducer = await captureReducerStateV1(tx, input.syncGenerationId);
    const prose = await captureProseDocuments(tx, authoredTables);
    const frontierRows = await tx
      .select()
      .from(SyncFrontierTable)
      .where(eq(SyncFrontierTable.syncGenerationId, input.syncGenerationId))
      .orderBy(asc(SyncFrontierTable.writerId), asc(SyncFrontierTable.writerEpoch));
    return {
      projectId: input.projectId,
      projectSyncId: generation.projectSyncId,
      syncGenerationId: generation.syncGenerationId,
      authored,
      reducer,
      prose,
      frontier: frontierRows.map((row) => {
        if ((row.appliedSeq === 0) !== (row.segmentHeadSha256 === null)) {
          throw new Error(
            `Applied frontier ${row.writerId}/${row.writerEpoch} is not anchored to a complete segment`,
          );
        }
        return {
          writerId: row.writerId,
          writerEpoch: row.writerEpoch,
          appliedSeq: row.appliedSeq,
          segmentHeadHash: row.segmentHeadSha256 ? protocolSha256(row.segmentHeadSha256) : null,
        };
      }),
    };
  });
}

async function captureAssets(
  read: ReadCapture,
  port: SnapshotAssetCapturePort | undefined,
): Promise<readonly CapturedAssetSourceV1[]> {
  const assetsTable = read.authored.tables.find((entry) => entry.table === 'project_asset');
  const rows = assetsTable?.rows ?? [];
  if (rows.length > 0 && !port) {
    throw new Error('Snapshot asset capture port is required when project assets exist');
  }
  const captured: CapturedAssetSourceV1[] = [];
  for (const row of rows) {
    const assetId = String(row.id);
    const expectedSourceSha256 = protocolSha256(String(row.source_sha256));
    const expectedSizeBytes = Number(row.source_size_bytes);
    const expectedMimeType = String(row.source_mime);
    const source = await port!.captureCanonicalSource({
      projectId: read.projectId,
      assetId,
      expectedSourceSha256,
      expectedSizeBytes,
      expectedMimeType,
    });
    if (
      source.sourceSha256 !== expectedSourceSha256 ||
      source.sizeBytes !== expectedSizeBytes ||
      source.mimeType !== expectedMimeType
    ) {
      throw new Error(`Canonical asset source verification failed for ${assetId}`);
    }
    captured.push({
      sourceRef: source.sourceRef,
      asset: {
        assetId,
        blobId: source.blobId,
        sourceSha256: source.sourceSha256,
        sizeBytes: source.sizeBytes,
        mimeType: source.mimeType,
      },
    });
  }
  return captured.sort((left, right) => compareUtf8Bytewise(left.asset.assetId, right.asset.assetId));
}

/**
 * Capture one immutable package from a single SQLite read transaction. Writes
 * queued after that transaction commit are deliberately outside its frontier
 * and remain ordinary journal records.
 */
export async function captureSnapshotV1(input: CaptureSnapshotInputV1): Promise<CapturedSnapshotV1> {
  const read = await readConsistentCapture(input);
  const assets = await captureAssets(read, input.assetPort);
  const authoredBytes = encodeCanonicalCbor(read.authored as unknown as CanonicalCborValue);
  const reducerBytes = encodeCanonicalCbor(read.reducer as unknown as CanonicalCborValue);
  const packageValue = {
    protocol: 'drifting.sync.snapshot' as const,
    protocolVersion: 1 as const,
    payloadVersion: 1 as const,
    codec: 'cbor-rfc8949' as const,
    compression: 'none' as const,
    snapshotKind: input.snapshotKind,
    snapshotId: input.snapshotId,
    projectId: read.projectId,
    projectSyncId: read.projectSyncId,
    syncGenerationId: read.syncGenerationId,
    capturedAt: input.capturedAt,
    domainManifestVersion: 1 as const,
    sqliteSchemaVersion: input.sqliteSchemaVersion ?? 1,
    frontier: [...read.frontier],
    authoredState: {
      section: 'drifting.sync.authored-state' as const,
      payloadVersion: 1 as const,
      codec: 'cbor-rfc8949' as const,
      compression: 'none' as const,
      bytes: authoredBytes,
      sha256: await sha256Bytes(authoredBytes),
    },
    reducerState: {
      section: 'drifting.sync.reducer-state' as const,
      payloadVersion: 1 as const,
      codec: 'cbor-rfc8949' as const,
      compression: 'none' as const,
      bytes: reducerBytes,
      sha256: await sha256Bytes(reducerBytes),
    },
    proseDocuments: [...read.prose],
    assets: assets.map((entry) => entry.asset),
    requiredBlobIds: [...new Set(assets.map((entry) => entry.asset.blobId))].sort(compareUtf8Bytewise),
  };
  const packageBytes = encodeSnapshotPackageV1(packageValue);
  const packageSha256 = await sha256Bytes(packageBytes);
  const commitMarker = {
    protocol: 'drifting.sync.snapshot-commit' as const,
    protocolVersion: 1 as const,
    payloadVersion: 1 as const,
    snapshotKind: input.snapshotKind,
    snapshotId: input.snapshotId,
    projectId: read.projectId,
    projectSyncId: read.projectSyncId,
    syncGenerationId: read.syncGenerationId,
    packageLogicalKeyId: input.packageLogicalKeyId,
    packageSha256,
    requiredBlobIds: packageValue.requiredBlobIds,
    committedAt: input.committedAt,
  };
  return {
    package: packageValue,
    packageBytes,
    packageSha256,
    commitMarker,
    commitMarkerBytes: encodeSnapshotCommitMarkerV1(commitMarker),
    assets,
  };
}
