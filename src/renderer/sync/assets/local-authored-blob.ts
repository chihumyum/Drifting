import { and, eq } from 'drizzle-orm';

import type { ProjectAsset } from '../../domain/project-asset';
import { getDb, type DbClient } from '../../lib/db';
import {
  SyncBlobStateTable,
  SyncLocalObjectTable,
} from '../../schema/drizzle';
import { nativeSyncObjectCodec } from '../native-object-codec';
import type { LocalObjectRef, Sha256 } from '../protocol';
import { findActiveSyncGenerationInTransaction } from '../journal/sync-generation-repository';
import type { SyncEngineBlobPort } from '../engine/blob-port';
import { nativeSyncAssetBlobPort } from './native-asset-pipeline';

type OutboundBlobPort = Pick<SyncEngineBlobPort, 'prepareOutbound'>;

export interface LocalAuthoredBlobDependencies {
  readonly database: () => DbClient;
  readonly blobPort: OutboundBlobPort;
  readonly discardLocal: (sourceRef: LocalObjectRef) => Promise<void>;
  readonly nowIso: () => string;
}

const defaultDependencies: LocalAuthoredBlobDependencies = {
  database: getDb,
  blobPort: nativeSyncAssetBlobPort,
  discardLocal: (sourceRef) => nativeSyncObjectCodec.discardLocal?.(sourceRef) ?? Promise.resolve(),
  nowIso: () => new Date().toISOString(),
};

function protocolSha256(hex: string): Sha256 {
  if (!/^[0-9a-f]{64}$/u.test(hex)) {
    throw new TypeError('local authored asset SHA-256 must be lowercase hexadecimal');
  }
  return `sha256:${hex}` as Sha256;
}

function hashHex(value: Sha256): string {
  return value.slice('sha256:'.length);
}

function normalizeMime(value: string): string {
  return value.split(';')[0]?.trim().toLowerCase() ?? '';
}

function localObjectId(syncGenerationId: string, logicalKeyId: string): string {
  return JSON.stringify(['local-object', syncGenerationId, logicalKeyId]);
}

/**
 * Verify and durably register a newly-authored canonical source before the
 * asset.bind mutation is post-write validated. SyncEngine later publishes the
 * already-verified opaque native object; it never needs to trust renderer
 * metadata or an absolute path.
 */
export async function ensureLocalAuthoredAssetBlobVerified(
  asset: ProjectAsset,
  dependencies: LocalAuthoredBlobDependencies = defaultDependencies,
): Promise<void> {
  const database = dependencies.database();
  const blobId = protocolSha256(asset.sourceSha256);
  const initial = await database.transaction(async (tx) => {
    const generation = await findActiveSyncGenerationInTransaction(tx, asset.projectId);
    if (!generation) {
      throw new Error(`project ${asset.projectId} has no active SyncGeneration for its asset`);
    }
    const [existing] = await tx
      .select({
        contentSha256: SyncBlobStateTable.contentSha256,
        sizeBytes: SyncBlobStateTable.sizeBytes,
        mime: SyncBlobStateTable.mime,
        localState: SyncBlobStateTable.localState,
      })
      .from(SyncBlobStateTable)
      .where(
        and(
          eq(SyncBlobStateTable.syncGenerationId, generation.syncGenerationId),
          eq(SyncBlobStateTable.blobId, blobId),
        ),
      )
      .limit(1);
    return { generation, existing };
  });

  if (initial.existing) {
    if (
      initial.existing.contentSha256 !== asset.sourceSha256 ||
      initial.existing.sizeBytes !== asset.sourceSizeBytes ||
      normalizeMime(initial.existing.mime) !== normalizeMime(asset.sourceMime)
    ) {
      throw new Error('existing local asset blob receipt conflicts with immutable metadata');
    }
    if (initial.existing.localState === 'verified') return;
  }

  const prepared = await dependencies.blobPort.prepareOutbound({
    syncGenerationId: initial.generation.syncGenerationId,
    projectId: asset.projectId,
    declaration: {
      assetId: asset.id,
      blobId,
      sourceSha256: blobId,
      sourceSizeBytes: asset.sourceSizeBytes,
      sourceMime: asset.sourceMime,
    },
  });
  let recorded = false;
  try {
    if (
      prepared.contentSha256 !== blobId ||
      prepared.storedSha256 !== blobId ||
      prepared.sizeBytes !== asset.sourceSizeBytes
    ) {
      throw new Error('native local asset verification changed immutable metadata');
    }
    const objectId = localObjectId(initial.generation.syncGenerationId, prepared.logicalKeyId);
    const nowIso = dependencies.nowIso();
    await database.transaction(async (tx) => {
      const active = await findActiveSyncGenerationInTransaction(tx, asset.projectId);
      if (active?.syncGenerationId !== initial.generation.syncGenerationId) {
        throw new Error('project sync authority changed while verifying a local asset');
      }
      await tx
        .insert(SyncLocalObjectTable)
        .values({
          id: objectId,
          syncGenerationId: active.syncGenerationId,
          objectKind: 'blob',
          logicalKeyId: prepared.logicalKeyId,
          storageRef: prepared.sourceRef,
          storedSha256: hashHex(prepared.storedSha256),
          contentSha256: hashHex(prepared.contentSha256),
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
            storedSha256: hashHex(prepared.storedSha256),
            contentSha256: hashHex(prepared.contentSha256),
            sizeBytes: prepared.sizeBytes,
            state: 'verified',
            verifiedAt: nowIso,
          },
        });
      await tx
        .insert(SyncBlobStateTable)
        .values({
          syncGenerationId: active.syncGenerationId,
          blobId,
          assetId: asset.id,
          logicalKeyId: prepared.logicalKeyId,
          contentSha256: asset.sourceSha256,
          sizeBytes: asset.sourceSizeBytes,
          mime: normalizeMime(asset.sourceMime),
          localObjectId: objectId,
          localState: 'verified',
          remoteState: 'missing',
          verifiedAt: nowIso,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: [SyncBlobStateTable.syncGenerationId, SyncBlobStateTable.blobId],
          set: {
            assetId: asset.id,
            logicalKeyId: prepared.logicalKeyId,
            contentSha256: asset.sourceSha256,
            sizeBytes: asset.sourceSizeBytes,
            mime: normalizeMime(asset.sourceMime),
            localObjectId: objectId,
            localState: 'verified',
            verifiedAt: nowIso,
            updatedAt: nowIso,
          },
        });
    });
    recorded = true;
  } finally {
    if (!recorded) await dependencies.discardLocal(prepared.sourceRef).catch(() => undefined);
  }
}
