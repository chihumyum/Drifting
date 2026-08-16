import { Type, type Static } from '@sinclair/typebox';

import { hashCanonicalCbor } from './canonical-cbor';
import {
  DOMAIN_KIND_SCHEMA,
  HLC_SCHEMA,
  OPAQUE_ID_SCHEMA,
  POSITIVE_SAFE_INTEGER_SCHEMA,
  PROTOCOL_TOKEN_SCHEMA,
  SAFE_UNSIGNED_INTEGER_SCHEMA,
  SHA256_SCHEMA,
  SYNC_PAYLOAD_VERSION,
  SYNC_PROTOCOL_VERSION,
  assertCanonicalCborValue,
  type CanonicalCborValue,
} from './primitives';
import type { ProtocolValidationIssue } from './validation';
import {
  decodeVersionedProtocol,
  encodeVersionedProtocol,
  quarantineProtocolBytes,
  type RequiredVersionMismatch,
  type VersionedProtocolDecodeResult,
} from './versioned-codec';

export const SYNC_CHANGESET_PROTOCOL = 'drifting.sync.changeset' as const;

export const SYNC_MUTATION_TARGET_FAMILIES = [
  'entity',
  'set',
  'order',
  'yjs',
  'asset',
  'sync-generation',
] as const;

export const SYNC_MUTATION_ACTIONS = [
  'entity.create',
  'field.set',
  'tuple.set',
  'set.add',
  'set.remove',
  'order.move',
  'order.rebalance',
  'entity.trash',
  'entity.restore',
  'entity.purge',
  'sync-generation.purge',
  'yjs.update',
  'asset.bind',
  'asset.unbind',
] as const;

export const SYNC_MUTATION_TARGET_FAMILY_SCHEMA = Type.Union([
  Type.Literal('entity'),
  Type.Literal('set'),
  Type.Literal('order'),
  Type.Literal('yjs'),
  Type.Literal('asset'),
  Type.Literal('sync-generation'),
]);
export const SYNC_MUTATION_ACTION_SCHEMA = Type.Union([
  Type.Literal('entity.create'),
  Type.Literal('field.set'),
  Type.Literal('tuple.set'),
  Type.Literal('set.add'),
  Type.Literal('set.remove'),
  Type.Literal('order.move'),
  Type.Literal('order.rebalance'),
  Type.Literal('entity.trash'),
  Type.Literal('entity.restore'),
  Type.Literal('entity.purge'),
  Type.Literal('sync-generation.purge'),
  Type.Literal('yjs.update'),
  Type.Literal('asset.bind'),
  Type.Literal('asset.unbind'),
]);

export const SYNC_MUTATION_TARGET_V1_SCHEMA = Type.Object(
  {
    family: SYNC_MUTATION_TARGET_FAMILY_SCHEMA,
    kind: DOMAIN_KIND_SCHEMA,
    id: OPAQUE_ID_SCHEMA,
    incarnation: SAFE_UNSIGNED_INTEGER_SCHEMA,
  },
  { additionalProperties: false },
);

export const SYNC_MUTATION_V1_SCHEMA = Type.Object(
  {
    index: SAFE_UNSIGNED_INTEGER_SCHEMA,
    target: SYNC_MUTATION_TARGET_V1_SCHEMA,
    action: SYNC_MUTATION_ACTION_SCHEMA,
    payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    payload: Type.Unknown(),
    payloadSha256: SHA256_SCHEMA,
  },
  { additionalProperties: false },
);

export const SYNC_CHANGESET_V1_SCHEMA = Type.Object(
  {
    protocol: Type.Literal(SYNC_CHANGESET_PROTOCOL),
    protocolVersion: Type.Literal(SYNC_PROTOCOL_VERSION),
    payloadVersion: Type.Literal(SYNC_PAYLOAD_VERSION),
    projectId: OPAQUE_ID_SCHEMA,
    projectSyncId: OPAQUE_ID_SCHEMA,
    syncGenerationId: OPAQUE_ID_SCHEMA,
    changeSetId: Type.String({ minLength: 5, maxLength: 300 }),
    writerId: PROTOCOL_TOKEN_SCHEMA,
    writerEpoch: PROTOCOL_TOKEN_SCHEMA,
    deviceSeq: POSITIVE_SAFE_INTEGER_SCHEMA,
    hlc: HLC_SCHEMA,
    mutations: Type.Array(SYNC_MUTATION_V1_SCHEMA, { minItems: 1, maxItems: 100_000 }),
  },
  { additionalProperties: false },
);

export type SyncMutationTargetFamily = (typeof SYNC_MUTATION_TARGET_FAMILIES)[number];
export type SyncMutationAction = (typeof SYNC_MUTATION_ACTIONS)[number];
export type SyncMutationTargetV1 = Static<typeof SYNC_MUTATION_TARGET_V1_SCHEMA>;
export type SyncMutationV1 = Static<typeof SYNC_MUTATION_V1_SCHEMA> & {
  payload: CanonicalCborValue;
};
export type SyncChangeSetV1 = Omit<Static<typeof SYNC_CHANGESET_V1_SCHEMA>, 'mutations'> & {
  mutations: SyncMutationV1[];
};

const ACTION_FAMILY: Readonly<Record<SyncMutationAction, SyncMutationTargetFamily>> = {
  'entity.create': 'entity',
  'field.set': 'entity',
  'tuple.set': 'entity',
  'set.add': 'set',
  'set.remove': 'set',
  'order.move': 'order',
  'order.rebalance': 'order',
  'entity.trash': 'entity',
  'entity.restore': 'entity',
  'entity.purge': 'entity',
  'sync-generation.purge': 'sync-generation',
  'yjs.update': 'yjs',
  'asset.bind': 'asset',
  'asset.unbind': 'asset',
};

export function validateSyncChangeSetV1Invariants(
  value: Static<typeof SYNC_CHANGESET_V1_SCHEMA>,
): readonly ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  const expectedId = `${value.writerId}:${value.writerEpoch}:${value.deviceSeq}`;
  if (value.changeSetId !== expectedId) {
    issues.push({ path: '/changeSetId', message: `must equal ${expectedId}` });
  }

  value.mutations.forEach((mutation, index) => {
    if (mutation.index !== index) {
      issues.push({ path: `/mutations/${index}/index`, message: `must equal ${index}` });
    }
    const expectedFamily = ACTION_FAMILY[mutation.action];
    if (mutation.target.family !== expectedFamily) {
      issues.push({
        path: `/mutations/${index}/target/family`,
        message: `${mutation.action} requires target family ${expectedFamily}`,
      });
    }
    try {
      // Payloads are action/kind versioned, but their shared transport data model is frozen here.
      // Domain-specific allowlists validate these maps before journaling and materialization.
      assertCanonicalCborValue(mutation.payload);
    } catch (error) {
      issues.push({
        path: `/mutations/${index}/payload`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return issues;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function findSyncChangeSetRequiredVersionMismatch(
  value: Readonly<Record<string, unknown>>,
  pathPrefix = '',
  includeEnvelope = false,
): RequiredVersionMismatch | null {
  if (includeEnvelope && value.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    return {
      kind: 'protocol',
      path: `${pathPrefix}/protocolVersion`,
      expected: SYNC_PROTOCOL_VERSION,
      observed: value.protocolVersion,
    };
  }
  if (includeEnvelope && value.payloadVersion !== SYNC_PAYLOAD_VERSION) {
    return {
      kind: 'payload',
      path: `${pathPrefix}/payloadVersion`,
      expected: SYNC_PAYLOAD_VERSION,
      observed: value.payloadVersion,
    };
  }
  if (!Array.isArray(value.mutations)) return null;
  for (let index = 0; index < value.mutations.length; index += 1) {
    const mutation = recordValue(value.mutations[index]);
    if (mutation && mutation.payloadVersion !== SYNC_PAYLOAD_VERSION) {
      return {
        kind: 'payload',
        path: `${pathPrefix}/mutations/${index}/payloadVersion`,
        expected: SYNC_PAYLOAD_VERSION,
        observed: mutation.payloadVersion,
      };
    }
  }
  return null;
}

const CHANGESET_DESCRIPTOR = {
  protocol: SYNC_CHANGESET_PROTOCOL,
  protocolVersion: SYNC_PROTOCOL_VERSION,
  payloadVersion: SYNC_PAYLOAD_VERSION,
  schema: SYNC_CHANGESET_V1_SCHEMA,
  validateInvariants: validateSyncChangeSetV1Invariants,
  findUnsupportedRequiredVersion: findSyncChangeSetRequiredVersionMismatch,
} as const;

export async function createSyncMutationV1(
  input: Omit<SyncMutationV1, 'payloadSha256'>,
): Promise<SyncMutationV1> {
  return { ...input, payloadSha256: await hashCanonicalCbor(input.payload) };
}

export function encodeSyncChangeSetV1(value: SyncChangeSetV1): Uint8Array {
  return encodeVersionedProtocol(value, CHANGESET_DESCRIPTOR);
}

export async function decodeSyncChangeSetV1(
  bytes: Uint8Array,
): Promise<VersionedProtocolDecodeResult<SyncChangeSetV1>> {
  const decoded = decodeVersionedProtocol(bytes, CHANGESET_DESCRIPTOR);
  if (!decoded.ok) return decoded;

  for (let index = 0; index < decoded.value.mutations.length; index += 1) {
    const mutation = decoded.value.mutations[index];
    let actualHash: string;
    try {
      actualHash = await hashCanonicalCbor(mutation.payload as CanonicalCborValue);
    } catch (error) {
      return quarantineProtocolBytes(bytes, 'schema-invalid', 'mutation payload is not canonical CBOR', {
        path: `/mutations/${index}/payload`,
        observed: error instanceof Error ? error.message : String(error),
      });
    }
    if (actualHash !== mutation.payloadSha256) {
      return quarantineProtocolBytes(bytes, 'integrity-mismatch', 'mutation payload hash mismatch', {
        path: `/mutations/${index}/payloadSha256`,
        expected: mutation.payloadSha256,
        observed: actualHash,
      });
    }
  }

  return decoded as VersionedProtocolDecodeResult<SyncChangeSetV1>;
}
