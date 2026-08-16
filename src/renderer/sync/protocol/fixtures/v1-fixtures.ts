import { hexToBytes } from '../canonical-cbor';
import {
  SYNC_CHANGESET_PROTOCOL,
  type SyncChangeSetV1,
} from '../change-set';
import {
  SYNC_CBOR_CODEC,
  SYNC_COMPRESSION,
  SYNC_PAYLOAD_VERSION,
  SYNC_PROTOCOL_VERSION,
} from '../primitives';
import { SYNC_SEGMENT_PROTOCOL, type SegmentV1 } from '../segment';
import {
  SYNC_SNAPSHOT_COMMIT_PROTOCOL,
  SYNC_SNAPSHOT_PROTOCOL,
  type SnapshotCommitMarkerV1,
  type SnapshotPackageV1,
} from '../snapshot';

export const GOLDEN_PAYLOAD_V1 = {
  field: 'title',
  value: 'First',
  binary: new Uint8Array([0, 1, 255]),
} as const;

export const GOLDEN_CHANGESET_V1: SyncChangeSetV1 = {
  protocol: SYNC_CHANGESET_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  projectId: 'project-golden',
  projectSyncId: 'projectSync-golden',
  syncGenerationId: 'sync-generation-golden',
  changeSetId: 'writer-a:epoch-a:1',
  writerId: 'writer-a',
  writerEpoch: 'epoch-a',
  deviceSeq: 1,
  hlc: { wallMs: 1_786_660_000_000, counter: 3 },
  mutations: [
    {
      index: 0,
      target: { family: 'entity', kind: 'node', id: 'node-a', incarnation: 0 },
      action: 'field.set',
      payloadVersion: SYNC_PAYLOAD_VERSION,
      payload: GOLDEN_PAYLOAD_V1,
      payloadSha256: 'sha256:b7c59fc8369982269a0729960be63152999aee1a50b7bf2ac2d4a0453f3aa081',
    },
  ],
};

export const GOLDEN_SEGMENT_V1: SegmentV1 = {
  protocol: SYNC_SEGMENT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  header: {
    codec: SYNC_CBOR_CODEC,
    compression: SYNC_COMPRESSION,
    projectId: 'project-golden',
    projectSyncId: 'projectSync-golden',
    syncGenerationId: 'sync-generation-golden',
    writerId: 'writer-a',
    writerEpoch: 'epoch-a',
    firstSeq: 1,
    lastSeq: 1,
    opCount: 1,
    previousSegmentHash: null,
    requiredBlobIds: ['blob-a', 'blob-z'],
  },
  changeSets: [GOLDEN_CHANGESET_V1],
};

export const GOLDEN_SNAPSHOT_V1: SnapshotPackageV1 = {
  protocol: SYNC_SNAPSHOT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  codec: SYNC_CBOR_CODEC,
  compression: SYNC_COMPRESSION,
  snapshotKind: 'genesis',
  snapshotId: 'snapshot-golden',
  projectId: 'project-golden',
  projectSyncId: 'projectSync-golden',
  syncGenerationId: 'sync-generation-golden',
  capturedAt: { wallMs: 1_786_660_000_100, counter: 0 },
  domainManifestVersion: 1,
  sqliteSchemaVersion: 1,
  frontier: [
    {
      writerId: 'writer-a',
      writerEpoch: 'epoch-a',
      appliedSeq: 1,
      segmentHeadHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  ],
  authoredState: {
    section: 'drifting.sync.authored-state',
    payloadVersion: 1,
    codec: SYNC_CBOR_CODEC,
    compression: SYNC_COMPRESSION,
    bytes: hexToBytes('a168656e74697469657381a2626964666e6f64652d61657469746c65654669727374'),
    sha256: 'sha256:25f153af53531c4b579719d1649f6265ba4bccc6c455438d11dabac86a0893b7',
  },
  reducerState: {
    section: 'drifting.sync.reducer-state',
    payloadVersion: 1,
    codec: SYNC_CBOR_CODEC,
    compression: SYNC_COMPRESSION,
    bytes: hexToBytes('a16b6669656c64436c6f636b7380'),
    sha256: 'sha256:985d920499a472d40f0aa8f3fd1ffa5c0d4cd65bf09ba5cc7735972413873c92',
  },
  proseDocuments: [
    {
      documentId: 'doc-a',
      mode: 'full-state',
      state: new Uint8Array([1, 2, 3]),
      stateSha256: 'sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    },
    {
      documentId: 'doc-b',
      mode: 'seed-only',
      payloadVersion: 1,
      seed: { type: 'doc', content: [] },
      seedSha256: 'sha256:ebaaa774b65c6e28e8ae52de2174ec8d68344c74014e1a1a6391bf5120b2913c',
    },
  ],
  assets: [
    {
      assetId: 'asset-a',
      blobId: 'blob-a',
      sourceSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      sizeBytes: 3,
      mimeType: 'image/png',
    },
  ],
  requiredBlobIds: ['blob-a'],
};

export const GOLDEN_SNAPSHOT_COMMIT_V1: SnapshotCommitMarkerV1 = {
  protocol: SYNC_SNAPSHOT_COMMIT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  snapshotKind: 'genesis',
  snapshotId: 'snapshot-golden',
  projectId: 'project-golden',
  projectSyncId: 'projectSync-golden',
  syncGenerationId: 'sync-generation-golden',
  packageLogicalKeyId: 'snapshot-object-golden',
  packageSha256: 'sha256:66b250f8e1b301057fcbb7d7e69d45016d0c6bdc705acbc2cf2d57a6bde543bb',
  requiredBlobIds: ['blob-a'],
  committedAt: { wallMs: 1_786_660_000_200, counter: 0 },
};
