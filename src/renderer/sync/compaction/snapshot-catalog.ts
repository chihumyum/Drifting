import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { DbClient } from '../../lib/db';
import { SyncLocalObjectTable, SyncRemoteObjectTable, SyncTransferTable } from '../../schema/drizzle';
import { validateSnapshotForRestore, type ValidatedSnapshot } from '../checkpoint/validate';
import type { SyncEngineObjectCodec } from '../engine/object-codec';
import {
  createLocalObjectRef,
  createProviderObjectId,
  decodeSnapshotCommitMarkerV1,
  decodeSnapshotPackage,
  sha256Bytes,
  type LocalObjectRef,
  type ProviderObjectId,
  type RemoteObject,
  type SnapshotCommitMarkerV1,
  type SnapshotKind,
  type SyncObjectKind,
} from '../protocol';
import { compareSnapshotOrder, laneFrontierFromSnapshot, type LaneFrontier, type OrderedSnapshot } from './frontier';

/** One committed snapshot whose marker and package bytes are local. */
export interface RemoteSnapshotEntry extends OrderedSnapshot {
  readonly snapshotKind: SnapshotKind;
  readonly marker: SnapshotCommitMarkerV1;
  readonly markerObject: RemoteObject;
  readonly markerSourceRef: LocalObjectRef;
  readonly packageObject: RemoteObject;
  readonly packageSourceRef: LocalObjectRef;
}

export interface RemoteSnapshotCatalog {
  /** Newest first in the dominance-compatible snapshot order. */
  readonly entries: readonly RemoteSnapshotEntry[];
  /**
   * Some committed marker is not yet local or could not be decoded. The
   * catalog then cannot prove which snapshots exist, so nothing may be pruned.
   */
  readonly incomplete: boolean;
}

interface LocalSnapshotObject {
  readonly object: RemoteObject;
  readonly sourceRef: LocalObjectRef;
}

const SNAPSHOT_OBJECT_KINDS = ['genesis', 'checkpoint', 'snapshot-commit'] as const;

/** Package frontiers keyed by content hash: immutable, so safe to memoize. */
const frontierCache = new Map<string, LaneFrontier>();
const FRONTIER_CACHE_LIMIT = 64;

async function canonicalLogicalKeyId(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

/**
 * Remote snapshot objects whose bytes are available locally: downloaded by
 * pull, or published by this installation. Pruned objects are excluded.
 */
async function localSnapshotObjects(
  db: DbClient,
  syncGenerationId: string,
): Promise<{ readonly available: LocalSnapshotObject[]; readonly unavailableMarkers: number }> {
  const rows = await db
    .select({
      remoteId: SyncRemoteObjectTable.id,
      objectId: SyncRemoteObjectTable.providerObjectId,
      objectKind: SyncRemoteObjectTable.objectKind,
      logicalKeyId: SyncRemoteObjectTable.logicalKeyId,
      storedSha256: SyncRemoteObjectTable.storedSha256,
      sizeBytes: SyncRemoteObjectTable.sizeBytes,
      localState: SyncLocalObjectTable.state,
      localSha256: SyncLocalObjectTable.storedSha256,
      storageRef: SyncLocalObjectTable.storageRef,
    })
    .from(SyncRemoteObjectTable)
    .leftJoin(
      SyncLocalObjectTable,
      and(
        eq(SyncLocalObjectTable.syncGenerationId, SyncRemoteObjectTable.syncGenerationId),
        eq(SyncLocalObjectTable.logicalKeyId, SyncRemoteObjectTable.logicalKeyId),
      ),
    )
    .where(
      and(
        eq(SyncRemoteObjectTable.syncGenerationId, syncGenerationId),
        isNull(SyncRemoteObjectTable.removedAt),
        inArray(SyncRemoteObjectTable.objectKind, [...SNAPSHOT_OBJECT_KINDS]),
      ),
    );
  const downloaded = new Set(
    (
      await db
        .select({ remoteId: SyncTransferTable.remoteObjectId })
        .from(SyncTransferTable)
        .where(
          and(
            eq(SyncTransferTable.syncGenerationId, syncGenerationId),
            eq(SyncTransferTable.direction, 'download'),
            eq(SyncTransferTable.state, 'completed'),
            inArray(SyncTransferTable.objectKind, [...SNAPSHOT_OBJECT_KINDS]),
          ),
        )
    ).map((row) => row.remoteId),
  );
  const available: LocalSnapshotObject[] = [];
  let unavailableMarkers = 0;
  for (const row of rows) {
    const bytesLocal =
      row.storageRef !== null &&
      row.localSha256 === row.storedSha256 &&
      (row.localState === 'verified' ||
        row.localState === 'published' ||
        (row.localState === 'staged' && downloaded.has(row.remoteId)));
    if (!bytesLocal) {
      if (row.objectKind === 'snapshot-commit') unavailableMarkers += 1;
      continue;
    }
    available.push({
      object: {
        objectId: createProviderObjectId(row.objectId),
        objectKind: row.objectKind as SyncObjectKind,
        logicalKeyId: row.logicalKeyId,
        storedSha256: `sha256:${row.storedSha256}` as RemoteObject['storedSha256'],
        sizeBytes: row.sizeBytes,
      },
      sourceRef: createLocalObjectRef(row.storageRef!),
    });
  }
  return { available, unavailableMarkers };
}

async function packageFrontier(
  objectCodec: SyncEngineObjectCodec,
  syncGenerationId: string,
  local: LocalSnapshotObject,
  expectedSha256: string,
): Promise<LaneFrontier | null> {
  const cached = frontierCache.get(expectedSha256);
  if (cached) return cached;
  const decoded = await objectCodec.decodeInbound({
    syncGenerationId,
    expectedLogicalKeyId: local.object.logicalKeyId,
    remoteObject: local.object,
    sourceRef: local.sourceRef,
  });
  if (decoded.contentSha256 !== expectedSha256) return null;
  const result = await decodeSnapshotPackage(decoded.protocolBytes);
  if (!result.ok) return null;
  const frontier = laneFrontierFromSnapshot(result.value.value.frontier);
  if (frontierCache.size >= FRONTIER_CACHE_LIMIT) {
    frontierCache.delete(frontierCache.keys().next().value!);
  }
  frontierCache.set(expectedSha256, frontier);
  return frontier;
}

/**
 * Every committed snapshot of one SyncGeneration whose marker and package are
 * local, in the order restore, catch-up and pruning all agree on.
 */
export async function loadRemoteSnapshotCatalog(input: {
  readonly db: DbClient;
  readonly syncGenerationId: string;
  readonly objectCodec: SyncEngineObjectCodec;
}): Promise<RemoteSnapshotCatalog> {
  const { available, unavailableMarkers } = await localSnapshotObjects(input.db, input.syncGenerationId);
  const byLogicalKey = new Map(available.map((local) => [local.object.logicalKeyId, local]));
  const entries: RemoteSnapshotEntry[] = [];
  let incomplete = unavailableMarkers > 0;
  for (const local of available) {
    if (local.object.objectKind !== 'snapshot-commit') continue;
    try {
      const decoded = await input.objectCodec.decodeInbound({
        syncGenerationId: input.syncGenerationId,
        expectedLogicalKeyId: local.object.logicalKeyId,
        remoteObject: local.object,
        sourceRef: local.sourceRef,
      });
      const markerResult = decodeSnapshotCommitMarkerV1(decoded.protocolBytes);
      if (!markerResult.ok) throw new Error(markerResult.reason);
      const marker = markerResult.value;
      const identity = `snapshot/${input.syncGenerationId}/${marker.snapshotKind}/${marker.snapshotId}`;
      if (
        marker.syncGenerationId !== input.syncGenerationId ||
        local.object.logicalKeyId !== (await canonicalLogicalKeyId(`${identity}/commit`)) ||
        marker.packageLogicalKeyId !== (await canonicalLogicalKeyId(`${identity}/package`))
      ) {
        throw new Error('snapshot marker identity mismatch');
      }
      const packageLocal = byLogicalKey.get(marker.packageLogicalKeyId);
      if (!packageLocal || packageLocal.object.objectKind !== marker.snapshotKind) {
        incomplete = true;
        continue;
      }
      const frontier = await packageFrontier(
        input.objectCodec,
        input.syncGenerationId,
        packageLocal,
        marker.packageSha256,
      );
      if (!frontier) throw new Error('snapshot package does not match its marker');
      entries.push({
        frontier,
        committedAt: marker.committedAt,
        snapshotId: marker.snapshotId,
        snapshotKind: marker.snapshotKind,
        marker,
        markerObject: local.object,
        markerSourceRef: local.sourceRef,
        packageObject: packageLocal.object,
        packageSourceRef: packageLocal.sourceRef,
      });
    } catch {
      incomplete = true;
    }
  }
  entries.sort((left, right) => compareSnapshotOrder(right, left));
  return { entries, incomplete };
}

/** Full isolated restore validation, required before a snapshot is relied on. */
export async function validateCatalogSnapshot(input: {
  readonly syncGenerationId: string;
  readonly objectCodec: SyncEngineObjectCodec;
  readonly entry: RemoteSnapshotEntry;
}): Promise<ValidatedSnapshot> {
  const read = (object: RemoteObject, sourceRef: LocalObjectRef) =>
    input.objectCodec.decodeInbound({
      syncGenerationId: input.syncGenerationId,
      expectedLogicalKeyId: object.logicalKeyId,
      remoteObject: object,
      sourceRef,
    });
  const [marker, packageBytes] = await Promise.all([
    read(input.entry.markerObject, input.entry.markerSourceRef),
    read(input.entry.packageObject, input.entry.packageSourceRef),
  ]);
  return validateSnapshotForRestore({
    packageBytes: packageBytes.protocolBytes,
    commitMarkerBytes: marker.protocolBytes,
    expected: {
      projectId: input.entry.marker.projectId,
      projectSyncId: input.entry.marker.projectSyncId,
      syncGenerationId: input.syncGenerationId,
    },
  });
}

export function snapshotObjectIds(entry: RemoteSnapshotEntry): readonly ProviderObjectId[] {
  return [entry.markerObject.objectId as ProviderObjectId, entry.packageObject.objectId as ProviderObjectId];
}
