import { Type, type Static } from '@sinclair/typebox';

import { decodeCanonicalCbor, hashCanonicalCbor, sha256Bytes } from './canonical-cbor';
import { compareUtf8Bytewise } from './order';
import {
  HLC_SCHEMA,
  OPAQUE_ID_SCHEMA,
  PROTOCOL_TOKEN_SCHEMA,
  SAFE_UNSIGNED_INTEGER_SCHEMA,
  SHA256_SCHEMA,
  SYNC_CBOR_CODEC,
  SYNC_COMPRESSION,
  SYNC_PAYLOAD_VERSION,
  SYNC_PROTOCOL_VERSION,
  type CanonicalCborValue,
} from './primitives';
import type { ProtocolValidationIssue } from './validation';
import {
  decodeVersionedProtocol,
  encodeVersionedProtocol,
  quarantineProtocolBytes,
  type VersionedProtocolDecodeResult,
} from './versioned-codec';

export const SYNC_SNAPSHOT_PROTOCOL = 'drifting.sync.snapshot' as const;
export const SYNC_SNAPSHOT_COMMIT_PROTOCOL = 'drifting.sync.snapshot-commit' as const;

export const SNAPSHOT_KIND_SCHEMA = Type.Union([
  Type.Literal('genesis'),
  Type.Literal('checkpoint'),
]);

export const SNAPSHOT_FRONTIER_ENTRY_V1_SCHEMA = Type.Object(
  {
    writerId: PROTOCOL_TOKEN_SCHEMA,
    writerEpoch: PROTOCOL_TOKEN_SCHEMA,
    appliedSeq: SAFE_UNSIGNED_INTEGER_SCHEMA,
    segmentHeadHash: Type.Union([SHA256_SCHEMA, Type.Null()]),
  },
  { additionalProperties: false },
);

const SNAPSHOT_CBOR_SECTION_BASE = {
  payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
  codec: Type.Literal(SYNC_CBOR_CODEC),
  compression: Type.Literal(SYNC_COMPRESSION),
  bytes: Type.Uint8Array(),
  sha256: SHA256_SCHEMA,
};

export const SNAPSHOT_AUTHORED_STATE_V1_SCHEMA = Type.Object(
  {
    section: Type.Literal('drifting.sync.authored-state'),
    ...SNAPSHOT_CBOR_SECTION_BASE,
  },
  { additionalProperties: false },
);

export const SNAPSHOT_REDUCER_STATE_V1_SCHEMA = Type.Object(
  {
    section: Type.Literal('drifting.sync.reducer-state'),
    ...SNAPSHOT_CBOR_SECTION_BASE,
  },
  { additionalProperties: false },
);

export const SNAPSHOT_PROSE_FULL_STATE_V1_SCHEMA = Type.Object(
  {
    documentId: OPAQUE_ID_SCHEMA,
    mode: Type.Literal('full-state'),
    state: Type.Uint8Array(),
    stateSha256: SHA256_SCHEMA,
  },
  { additionalProperties: false },
);

export const SNAPSHOT_PROSE_SEED_ONLY_V1_SCHEMA = Type.Object(
  {
    documentId: OPAQUE_ID_SCHEMA,
    mode: Type.Literal('seed-only'),
    payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    seed: Type.Unknown(),
    seedSha256: SHA256_SCHEMA,
  },
  { additionalProperties: false },
);

export const SNAPSHOT_PROSE_DOCUMENT_V1_SCHEMA = Type.Union([
  SNAPSHOT_PROSE_FULL_STATE_V1_SCHEMA,
  SNAPSHOT_PROSE_SEED_ONLY_V1_SCHEMA,
]);

export const SNAPSHOT_ASSET_V1_SCHEMA = Type.Object(
  {
    assetId: OPAQUE_ID_SCHEMA,
    blobId: OPAQUE_ID_SCHEMA,
    sourceSha256: SHA256_SCHEMA,
    sizeBytes: SAFE_UNSIGNED_INTEGER_SCHEMA,
    mimeType: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { additionalProperties: false },
);

export const SNAPSHOT_PACKAGE_V1_SCHEMA = Type.Object(
  {
    protocol: Type.Literal(SYNC_SNAPSHOT_PROTOCOL),
    protocolVersion: Type.Literal(SYNC_PROTOCOL_VERSION),
    payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    codec: Type.Literal(SYNC_CBOR_CODEC),
    compression: Type.Literal(SYNC_COMPRESSION),
    snapshotKind: SNAPSHOT_KIND_SCHEMA,
    snapshotId: OPAQUE_ID_SCHEMA,
    projectId: OPAQUE_ID_SCHEMA,
    projectSyncId: OPAQUE_ID_SCHEMA,
    syncGenerationId: OPAQUE_ID_SCHEMA,
    capturedAt: HLC_SCHEMA,
    domainManifestVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    sqliteSchemaVersion: SAFE_UNSIGNED_INTEGER_SCHEMA,
    frontier: Type.Array(SNAPSHOT_FRONTIER_ENTRY_V1_SCHEMA, { maxItems: 100_000 }),
    authoredState: SNAPSHOT_AUTHORED_STATE_V1_SCHEMA,
    reducerState: SNAPSHOT_REDUCER_STATE_V1_SCHEMA,
    proseDocuments: Type.Array(SNAPSHOT_PROSE_DOCUMENT_V1_SCHEMA, { maxItems: 1_000_000 }),
    assets: Type.Array(SNAPSHOT_ASSET_V1_SCHEMA, { maxItems: 1_000_000 }),
    requiredBlobIds: Type.Array(OPAQUE_ID_SCHEMA, { maxItems: 1_000_000 }),
  },
  { additionalProperties: false },
);

export const SNAPSHOT_COMMIT_MARKER_V1_SCHEMA = Type.Object(
  {
    protocol: Type.Literal(SYNC_SNAPSHOT_COMMIT_PROTOCOL),
    protocolVersion: Type.Literal(SYNC_PROTOCOL_VERSION),
    payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    snapshotKind: SNAPSHOT_KIND_SCHEMA,
    snapshotId: OPAQUE_ID_SCHEMA,
    projectId: OPAQUE_ID_SCHEMA,
    projectSyncId: OPAQUE_ID_SCHEMA,
    syncGenerationId: OPAQUE_ID_SCHEMA,
    packageLogicalKeyId: OPAQUE_ID_SCHEMA,
    packageSha256: SHA256_SCHEMA,
    requiredBlobIds: Type.Array(OPAQUE_ID_SCHEMA, { maxItems: 1_000_000 }),
    committedAt: HLC_SCHEMA,
  },
  { additionalProperties: false },
);

/**
 * Payload v2 splits the authored and reducer sections into canonical CBOR
 * pages, so neither is bounded by the per-value node limit, and carries a
 * compacted reducer state instead of the complete reducer journal.
 */
export const SNAPSHOT_PACKAGE_PAYLOAD_VERSION_V2 = 2 as const;

export const SNAPSHOT_PAGE_V2_SCHEMA = Type.Object(
  { bytes: Type.Uint8Array(), sha256: SHA256_SCHEMA },
  { additionalProperties: false },
);

const SNAPSHOT_PAGED_SECTION_V2_BASE = {
  payloadVersion: Type.Literal(SNAPSHOT_PACKAGE_PAYLOAD_VERSION_V2),
  codec: Type.Literal(SYNC_CBOR_CODEC),
  compression: Type.Literal(SYNC_COMPRESSION),
  pages: Type.Array(SNAPSHOT_PAGE_V2_SCHEMA, { minItems: 1, maxItems: 100_000 }),
};

export const SNAPSHOT_AUTHORED_STATE_V2_SCHEMA = Type.Object(
  { section: Type.Literal('drifting.sync.authored-state'), ...SNAPSHOT_PAGED_SECTION_V2_BASE },
  { additionalProperties: false },
);

export const SNAPSHOT_REDUCER_STATE_V2_SCHEMA = Type.Object(
  { section: Type.Literal('drifting.sync.reducer-state'), ...SNAPSHOT_PAGED_SECTION_V2_BASE },
  { additionalProperties: false },
);

export const SNAPSHOT_PACKAGE_V2_SCHEMA = Type.Object(
  {
    ...SNAPSHOT_PACKAGE_V1_SCHEMA.properties,
    payloadVersion: Type.Literal(SNAPSHOT_PACKAGE_PAYLOAD_VERSION_V2),
    authoredState: SNAPSHOT_AUTHORED_STATE_V2_SCHEMA,
    reducerState: SNAPSHOT_REDUCER_STATE_V2_SCHEMA,
  },
  { additionalProperties: false },
);

export type SnapshotKind = Static<typeof SNAPSHOT_KIND_SCHEMA>;
export type SnapshotFrontierEntryV1 = Static<typeof SNAPSHOT_FRONTIER_ENTRY_V1_SCHEMA>;
export type SnapshotAuthoredStateV1 = Static<typeof SNAPSHOT_AUTHORED_STATE_V1_SCHEMA>;
export type SnapshotReducerStateV1 = Static<typeof SNAPSHOT_REDUCER_STATE_V1_SCHEMA>;
export type SnapshotProseDocumentV1 = Static<typeof SNAPSHOT_PROSE_DOCUMENT_V1_SCHEMA>;
export type SnapshotAssetV1 = Static<typeof SNAPSHOT_ASSET_V1_SCHEMA>;
export type SnapshotPackageV1 = Omit<
  Static<typeof SNAPSHOT_PACKAGE_V1_SCHEMA>,
  'proseDocuments'
> & {
  proseDocuments: Array<
    | Static<typeof SNAPSHOT_PROSE_FULL_STATE_V1_SCHEMA>
    | (Omit<Static<typeof SNAPSHOT_PROSE_SEED_ONLY_V1_SCHEMA>, 'seed'> & {
        seed: CanonicalCborValue;
      })
  >;
};
export type SnapshotCommitMarkerV1 = Static<typeof SNAPSHOT_COMMIT_MARKER_V1_SCHEMA>;
export type SnapshotPageV2 = Static<typeof SNAPSHOT_PAGE_V2_SCHEMA>;
export type SnapshotPackageV2 = Omit<
  SnapshotPackageV1,
  'payloadVersion' | 'authoredState' | 'reducerState'
> & {
  payloadVersion: typeof SNAPSHOT_PACKAGE_PAYLOAD_VERSION_V2;
  authoredState: Static<typeof SNAPSHOT_AUTHORED_STATE_V2_SCHEMA>;
  reducerState: Static<typeof SNAPSHOT_REDUCER_STATE_V2_SCHEMA>;
};

interface SnapshotCollections {
  readonly frontier: readonly SnapshotFrontierEntryV1[];
  readonly proseDocuments: readonly { readonly documentId: string }[];
  readonly assets: readonly SnapshotAssetV1[];
  readonly requiredBlobIds: readonly string[];
}

function isSortedUnique<T>(
  values: readonly T[],
  identity: (value: T) => readonly string[],
): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const left = identity(values[index - 1]);
    const right = identity(values[index]);
    let comparison = 0;
    for (let part = 0; part < Math.max(left.length, right.length); part += 1) {
      comparison = compareUtf8Bytewise(left[part] ?? '', right[part] ?? '');
      if (comparison !== 0) break;
    }
    if (comparison >= 0) return false;
  }
  return true;
}

function validateSortedSnapshotCollections(
  value: SnapshotCollections,
): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  if (!isSortedUnique(value.frontier, (entry) => [entry.writerId, entry.writerEpoch])) {
    issues.push({
      path: '/frontier',
      message: 'must be unique and sorted by writerId then writerEpoch using UTF-8 bytes',
    });
  }
  value.frontier.forEach((entry, index) => {
    if ((entry.appliedSeq === 0) !== (entry.segmentHeadHash === null)) {
      issues.push({
        path: `/frontier/${index}/segmentHeadHash`,
        message: 'must be null exactly when appliedSeq is zero',
      });
    }
  });
  if (!isSortedUnique(value.proseDocuments, (entry) => [entry.documentId])) {
    issues.push({
      path: '/proseDocuments',
      message: 'must be unique and sorted by documentId using UTF-8 bytes',
    });
  }
  if (!isSortedUnique(value.assets, (entry) => [entry.assetId])) {
    issues.push({
      path: '/assets',
      message: 'must be unique and sorted by assetId using UTF-8 bytes',
    });
  }
  if (!isSortedUnique(value.requiredBlobIds, (entry) => [entry])) {
    issues.push({
      path: '/requiredBlobIds',
      message: 'must be unique and sorted using UTF-8 bytes',
    });
  }

  const referencedBlobIds = [...new Set(value.assets.map((asset) => asset.blobId))].sort(
    compareUtf8Bytewise,
  );
  if (
    referencedBlobIds.length !== value.requiredBlobIds.length ||
    referencedBlobIds.some((blobId, index) => blobId !== value.requiredBlobIds[index])
  ) {
    issues.push({
      path: '/requiredBlobIds',
      message: 'must exactly equal the unique blob IDs referenced by assets',
    });
  }
  return issues;
}

export function validateSnapshotPackageV1Invariants(
  value: Static<typeof SNAPSHOT_PACKAGE_V1_SCHEMA>,
): readonly ProtocolValidationIssue[] {
  return validateSortedSnapshotCollections(value);
}

export function validateSnapshotCommitMarkerV1Invariants(
  value: SnapshotCommitMarkerV1,
): readonly ProtocolValidationIssue[] {
  return isSortedUnique(value.requiredBlobIds, (entry) => [entry])
    ? []
    : [
        {
          path: '/requiredBlobIds',
          message: 'must be unique and sorted using UTF-8 bytes',
        },
      ];
}

function findUnsupportedSnapshotSectionVersion(sectionVersion: number) {
  return (value: Readonly<Record<string, unknown>>) => {
    for (const key of ['authoredState', 'reducerState'] as const) {
      const section = value[key];
      if (
        section !== null &&
        typeof section === 'object' &&
        !Array.isArray(section) &&
        (section as Record<string, unknown>).payloadVersion !== sectionVersion
      ) {
        return {
          kind: 'payload' as const,
          path: `/${key}/payloadVersion`,
          expected: sectionVersion,
          observed: (section as Record<string, unknown>).payloadVersion,
        };
      }
    }
    if (!Array.isArray(value.proseDocuments)) return null;
    for (let index = 0; index < value.proseDocuments.length; index += 1) {
      const document = value.proseDocuments[index];
      if (
        document !== null &&
        typeof document === 'object' &&
        !Array.isArray(document) &&
        (document as Record<string, unknown>).mode === 'seed-only' &&
        (document as Record<string, unknown>).payloadVersion !== SYNC_PAYLOAD_VERSION
      ) {
        return {
          kind: 'payload' as const,
          path: `/proseDocuments/${index}/payloadVersion`,
          expected: SYNC_PAYLOAD_VERSION,
          observed: (document as Record<string, unknown>).payloadVersion,
        };
      }
    }
    return null;
  };
}

const SNAPSHOT_DESCRIPTOR = {
  protocol: SYNC_SNAPSHOT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  schema: SNAPSHOT_PACKAGE_V1_SCHEMA,
  validateInvariants: validateSnapshotPackageV1Invariants,
  findUnsupportedRequiredVersion: findUnsupportedSnapshotSectionVersion(SYNC_PAYLOAD_VERSION),
} as const;

const SNAPSHOT_V2_DESCRIPTOR = {
  protocol: SYNC_SNAPSHOT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SNAPSHOT_PACKAGE_PAYLOAD_VERSION_V2,
  schema: SNAPSHOT_PACKAGE_V2_SCHEMA,
  validateInvariants: (value: Static<typeof SNAPSHOT_PACKAGE_V2_SCHEMA>) => validateSortedSnapshotCollections(value),
  findUnsupportedRequiredVersion: findUnsupportedSnapshotSectionVersion(SNAPSHOT_PACKAGE_PAYLOAD_VERSION_V2),
} as const;

const SNAPSHOT_COMMIT_DESCRIPTOR = {
  protocol: SYNC_SNAPSHOT_COMMIT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  schema: SNAPSHOT_COMMIT_MARKER_V1_SCHEMA,
  validateInvariants: validateSnapshotCommitMarkerV1Invariants,
} as const;

export function encodeSnapshotPackageV1(value: SnapshotPackageV1): Uint8Array {
  return encodeVersionedProtocol(value, SNAPSHOT_DESCRIPTOR);
}

export function encodeSnapshotCommitMarkerV1(value: SnapshotCommitMarkerV1): Uint8Array {
  return encodeVersionedProtocol(value, SNAPSHOT_COMMIT_DESCRIPTOR);
}

async function verifySectionPage(
  path: string,
  page: { bytes: Uint8Array; sha256: string },
): Promise<{ path: string; expected: string; observed: string } | null> {
  const actualHash = await sha256Bytes(page.bytes);
  if (actualHash !== page.sha256) return { path: `${path}/sha256`, expected: page.sha256, observed: actualHash };
  const decoded = decodeCanonicalCbor(page.bytes);
  return decoded.ok ? null : { path: `${path}/bytes`, expected: 'canonical CBOR', observed: decoded.reason };
}

async function verifySnapshotPackageIntegrity(
  value: SnapshotPackageV1 | SnapshotPackageV2,
): Promise<{ path: string; expected: string; observed: string } | null> {
  for (const [path, section] of [
    ['/authoredState', value.authoredState],
    ['/reducerState', value.reducerState],
  ] as const) {
    const pages = 'pages' in section ? section.pages : [section];
    for (const [index, page] of pages.entries()) {
      const mismatch = await verifySectionPage('pages' in section ? `${path}/pages/${index}` : path, page);
      if (mismatch) return mismatch;
    }
  }

  for (let index = 0; index < value.proseDocuments.length; index += 1) {
    const document = value.proseDocuments[index];
    const actualHash =
      document.mode === 'full-state'
        ? await sha256Bytes(document.state)
        : await hashCanonicalCbor(document.seed);
    const expectedHash = document.mode === 'full-state' ? document.stateSha256 : document.seedSha256;
    if (actualHash !== expectedHash) {
      return {
        path: `/proseDocuments/${index}/${document.mode === 'full-state' ? 'stateSha256' : 'seedSha256'}`,
        expected: expectedHash,
        observed: actualHash,
      };
    }
  }
  return null;
}

export async function decodeSnapshotPackageV1(
  bytes: Uint8Array,
): Promise<VersionedProtocolDecodeResult<SnapshotPackageV1>> {
  const decoded = decodeVersionedProtocol(bytes, SNAPSHOT_DESCRIPTOR);
  if (!decoded.ok) return decoded;
  const value = decoded.value as SnapshotPackageV1;
  const mismatch = await verifySnapshotPackageIntegrity(value);
  if (mismatch) {
    return quarantineProtocolBytes(bytes, 'integrity-mismatch', 'snapshot package integrity failed', {
      path: mismatch.path,
      expected: mismatch.expected,
      observed: mismatch.observed,
    });
  }
  return { ...decoded, value };
}

export function encodeSnapshotPackageV2(value: SnapshotPackageV2): Uint8Array {
  return encodeVersionedProtocol(value as Static<typeof SNAPSHOT_PACKAGE_V2_SCHEMA>, SNAPSHOT_V2_DESCRIPTOR);
}

export type DecodedSnapshotPackage =
  | { readonly payloadVersion: 1; readonly value: SnapshotPackageV1 }
  | { readonly payloadVersion: 2; readonly value: SnapshotPackageV2 };

/** Decodes any supported package payload version; others fail closed. */
export async function decodeSnapshotPackage(
  bytes: Uint8Array,
): Promise<VersionedProtocolDecodeResult<DecodedSnapshotPackage>> {
  const decoded = decodeVersionedProtocol(bytes, SNAPSHOT_V2_DESCRIPTOR);
  if (!decoded.ok) {
    if (
      decoded.reason === 'unsupported-payload-version' &&
      decoded.path === '/payloadVersion' &&
      decoded.observed === SYNC_PAYLOAD_VERSION
    ) {
      const v1 = await decodeSnapshotPackageV1(bytes);
      return v1.ok ? { ...v1, value: { payloadVersion: 1, value: v1.value } } : v1;
    }
    return decoded;
  }
  const value = decoded.value as SnapshotPackageV2;
  const mismatch = await verifySnapshotPackageIntegrity(value);
  if (mismatch) {
    return quarantineProtocolBytes(bytes, 'integrity-mismatch', 'snapshot package integrity failed', {
      path: mismatch.path,
      expected: mismatch.expected,
      observed: mismatch.observed,
    });
  }
  return { ...decoded, value: { payloadVersion: 2, value } };
}

export function decodeSnapshotCommitMarkerV1(
  bytes: Uint8Array,
): VersionedProtocolDecodeResult<SnapshotCommitMarkerV1> {
  return decodeVersionedProtocol(bytes, SNAPSHOT_COMMIT_DESCRIPTOR);
}
