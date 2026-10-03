/**
 * Test support: production capture writes payload v2 only, but restore must
 * keep accepting the frozen payload v1 package. This builds a v1 package from
 * the same consistent read so the v1 restore path stays exercised.
 */
import {
  compareUtf8Bytewise,
  encodeCanonicalCbor,
  encodeSnapshotCommitMarkerV1,
  encodeSnapshotPackageV1,
  sha256Bytes,
  type CanonicalCborValue,
  type Sha256,
  type SnapshotCommitMarkerV1,
  type SnapshotPackageV1,
} from '../protocol';
import {
  captureAssets,
  captureFrontier,
  captureProseDocuments,
  requireCapturableGeneration,
  type CaptureSnapshotInput,
} from './capture';
import { captureAuthoredTablesV1 } from './domain-catalog';
import { captureReducerStateV1 } from './reducer-state';
import {
  AUTHORED_STATE_FORMAT_V1,
  type AuthoredStatePayloadV1,
  type CapturedAssetSourceV1,
} from './types';

export interface CapturedSnapshotV1 {
  readonly package: SnapshotPackageV1;
  readonly packageBytes: Uint8Array;
  readonly packageSha256: Sha256;
  readonly commitMarker: SnapshotCommitMarkerV1;
  readonly commitMarkerBytes: Uint8Array;
  readonly assets: readonly CapturedAssetSourceV1[];
}

export async function captureSnapshotV1ForTest(input: CaptureSnapshotInput): Promise<CapturedSnapshotV1> {
  const read = await input.db.transaction(async (tx) => {
    const generation = await requireCapturableGeneration(tx, input);
    const authoredTables = await captureAuthoredTablesV1(tx, input.projectId);
    return {
      projectId: input.projectId,
      projectSyncId: generation.projectSyncId,
      syncGenerationId: generation.syncGenerationId,
      authoredTables,
      reducer: await captureReducerStateV1(tx, input.syncGenerationId),
      prose: await captureProseDocuments(tx, authoredTables),
      frontier: await captureFrontier(tx, input.syncGenerationId),
    };
  });
  const assets = await captureAssets(read, input.assetPort);
  const authored: AuthoredStatePayloadV1 = {
    format: AUTHORED_STATE_FORMAT_V1,
    payloadVersion: 1,
    tables: read.authoredTables,
  };
  const authoredBytes = encodeCanonicalCbor(authored as unknown as CanonicalCborValue);
  const reducerBytes = encodeCanonicalCbor(read.reducer as unknown as CanonicalCborValue);
  const packageValue: SnapshotPackageV1 = {
    protocol: 'drifting.sync.snapshot',
    protocolVersion: 1,
    payloadVersion: 1,
    codec: 'cbor-rfc8949',
    compression: 'none',
    snapshotKind: input.snapshotKind,
    snapshotId: input.snapshotId,
    projectId: read.projectId,
    projectSyncId: read.projectSyncId,
    syncGenerationId: read.syncGenerationId,
    capturedAt: input.capturedAt,
    domainManifestVersion: 1,
    sqliteSchemaVersion: input.sqliteSchemaVersion ?? 1,
    frontier: [...read.frontier],
    authoredState: {
      section: 'drifting.sync.authored-state',
      payloadVersion: 1,
      codec: 'cbor-rfc8949',
      compression: 'none',
      bytes: authoredBytes,
      sha256: await sha256Bytes(authoredBytes),
    },
    reducerState: {
      section: 'drifting.sync.reducer-state',
      payloadVersion: 1,
      codec: 'cbor-rfc8949',
      compression: 'none',
      bytes: reducerBytes,
      sha256: await sha256Bytes(reducerBytes),
    },
    proseDocuments: [...read.prose],
    assets: assets.map((entry) => entry.asset),
    requiredBlobIds: [...new Set(assets.map((entry) => entry.asset.blobId))].sort(compareUtf8Bytewise),
  };
  const packageBytes = encodeSnapshotPackageV1(packageValue);
  const packageSha256 = await sha256Bytes(packageBytes);
  const commitMarker: SnapshotCommitMarkerV1 = {
    protocol: 'drifting.sync.snapshot-commit',
    protocolVersion: 1,
    payloadVersion: 1,
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
