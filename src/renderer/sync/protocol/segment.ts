import { Type, type Static } from '@sinclair/typebox';

import {
  SYNC_CHANGESET_V1_SCHEMA,
  findSyncChangeSetRequiredVersionMismatch,
  validateSyncChangeSetV1Invariants,
  type SyncChangeSetV1,
} from './change-set';
import { compareUtf8Bytewise } from './order';
import {
  OPAQUE_ID_SCHEMA,
  POSITIVE_SAFE_INTEGER_SCHEMA,
  PROTOCOL_TOKEN_SCHEMA,
  SHA256_SCHEMA,
  SYNC_CBOR_CODEC,
  SYNC_COMPRESSION,
  SYNC_PAYLOAD_VERSION,
  SYNC_PROTOCOL_VERSION,
} from './primitives';
import type { ProtocolValidationIssue } from './validation';
import {
  decodeVersionedProtocol,
  encodeVersionedProtocol,
  quarantineProtocolBytes,
  type VersionedProtocolDecodeResult,
} from './versioned-codec';
import { hashCanonicalCbor } from './canonical-cbor';

export const SYNC_SEGMENT_PROTOCOL = 'drifting.sync.segment' as const;

export const SEGMENT_HEADER_V1_SCHEMA = Type.Object(
  {
    codec: Type.Literal(SYNC_CBOR_CODEC),
    compression: Type.Literal(SYNC_COMPRESSION),
    projectId: OPAQUE_ID_SCHEMA,
    projectSyncId: OPAQUE_ID_SCHEMA,
    syncGenerationId: OPAQUE_ID_SCHEMA,
    writerId: PROTOCOL_TOKEN_SCHEMA,
    writerEpoch: PROTOCOL_TOKEN_SCHEMA,
    firstSeq: POSITIVE_SAFE_INTEGER_SCHEMA,
    lastSeq: POSITIVE_SAFE_INTEGER_SCHEMA,
    opCount: POSITIVE_SAFE_INTEGER_SCHEMA,
    previousSegmentHash: Type.Union([SHA256_SCHEMA, Type.Null()]),
    requiredBlobIds: Type.Array(OPAQUE_ID_SCHEMA, { maxItems: 100_000 }),
  },
  { additionalProperties: false },
);

export const SEGMENT_V1_SCHEMA = Type.Object(
  {
    protocol: Type.Literal(SYNC_SEGMENT_PROTOCOL),
    protocolVersion: Type.Literal(SYNC_PROTOCOL_VERSION),
    payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    header: SEGMENT_HEADER_V1_SCHEMA,
    changeSets: Type.Array(SYNC_CHANGESET_V1_SCHEMA, { minItems: 1, maxItems: 256 }),
  },
  { additionalProperties: false },
);

export type SegmentHeaderV1 = Static<typeof SEGMENT_HEADER_V1_SCHEMA>;
export type SegmentV1 = Omit<Static<typeof SEGMENT_V1_SCHEMA>, 'changeSets'> & {
  changeSets: SyncChangeSetV1[];
};

function sortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareUtf8Bytewise(values[index - 1], values[index]) >= 0) return false;
  }
  return true;
}

export function validateSegmentV1Invariants(
  value: Static<typeof SEGMENT_V1_SCHEMA>,
): readonly ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  const { header, changeSets } = value;
  if (header.opCount !== changeSets.length) {
    issues.push({ path: '/header/opCount', message: 'must equal changeSets.length' });
  }
  if (header.firstSeq > header.lastSeq) {
    issues.push({ path: '/header/firstSeq', message: 'must not exceed lastSeq' });
  }
  if (header.lastSeq - header.firstSeq + 1 !== changeSets.length) {
    issues.push({
      path: '/header/lastSeq',
      message: 'sequence range must contain exactly one entry per change set',
    });
  }
  if (!sortedUnique(header.requiredBlobIds)) {
    issues.push({
      path: '/header/requiredBlobIds',
      message: 'must be unique and sorted by UTF-8 bytes',
    });
  }

  changeSets.forEach((changeSet, index) => {
    const expectedSeq = header.firstSeq + index;
    if (changeSet.deviceSeq !== expectedSeq) {
      issues.push({ path: `/changeSets/${index}/deviceSeq`, message: `must equal ${expectedSeq}` });
    }
    for (const [field, expected] of [
      ['projectId', header.projectId],
      ['projectSyncId', header.projectSyncId],
      ['syncGenerationId', header.syncGenerationId],
      ['writerId', header.writerId],
      ['writerEpoch', header.writerEpoch],
    ] as const) {
      if (changeSet[field] !== expected) {
        issues.push({ path: `/changeSets/${index}/${field}`, message: `must equal header.${field}` });
      }
    }
    for (const issue of validateSyncChangeSetV1Invariants(changeSet)) {
      issues.push({ path: `/changeSets/${index}${issue.path}`, message: issue.message });
    }
  });
  return issues;
}

const SEGMENT_DESCRIPTOR = {
  protocol: SYNC_SEGMENT_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  schema: SEGMENT_V1_SCHEMA,
  validateInvariants: validateSegmentV1Invariants,
  findUnsupportedRequiredVersion: (value: Readonly<Record<string, unknown>>) => {
    if (!Array.isArray(value.changeSets)) return null;
    for (let index = 0; index < value.changeSets.length; index += 1) {
      const changeSet = value.changeSets[index];
      if (changeSet === null || typeof changeSet !== 'object' || Array.isArray(changeSet)) continue;
      const mismatch = findSyncChangeSetRequiredVersionMismatch(
        changeSet as Readonly<Record<string, unknown>>,
        `/changeSets/${index}`,
        true,
      );
      if (mismatch) return mismatch;
    }
    return null;
  },
} as const;

export function encodeSegmentV1(value: SegmentV1): Uint8Array {
  return encodeVersionedProtocol(value, SEGMENT_DESCRIPTOR);
}

export async function decodeSegmentV1(
  bytes: Uint8Array,
): Promise<VersionedProtocolDecodeResult<SegmentV1>> {
  const decoded = decodeVersionedProtocol(bytes, SEGMENT_DESCRIPTOR);
  if (!decoded.ok) return decoded;

  for (let changeIndex = 0; changeIndex < decoded.value.changeSets.length; changeIndex += 1) {
    const changeSet = decoded.value.changeSets[changeIndex];
    for (let mutationIndex = 0; mutationIndex < changeSet.mutations.length; mutationIndex += 1) {
      const mutation = changeSet.mutations[mutationIndex];
      const actualHash = await hashCanonicalCbor(mutation.payload as SyncChangeSetV1['mutations'][number]['payload']);
      if (actualHash !== mutation.payloadSha256) {
        return quarantineProtocolBytes(bytes, 'integrity-mismatch', 'mutation payload hash mismatch', {
          path: `/changeSets/${changeIndex}/mutations/${mutationIndex}/payloadSha256`,
          expected: mutation.payloadSha256,
          observed: actualHash,
        });
      }
    }
  }
  return decoded as VersionedProtocolDecodeResult<SegmentV1>;
}
