import type { Static, TSchema } from '@sinclair/typebox';

import {
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  type CborQuarantineReason,
} from './canonical-cbor';
import type { CanonicalCborValue } from './primitives';
import { validateSchema, type ProtocolValidationIssue } from './validation';

export type ProtocolQuarantineReason =
  | CborQuarantineReason
  | 'unexpected-protocol'
  | 'unsupported-protocol-version'
  | 'unsupported-payload-version'
  | 'schema-invalid'
  | 'invariant-invalid'
  | 'integrity-mismatch';

export interface ProtocolQuarantineResult {
  ok: false;
  disposition: 'quarantine';
  reason: ProtocolQuarantineReason;
  message: string;
  rawBytes: Uint8Array;
  path?: string;
  expected?: string | number;
  observed?: unknown;
  issues?: readonly ProtocolValidationIssue[];
}

export type VersionedProtocolDecodeResult<T> =
  | { ok: true; value: T; canonicalBytes: Uint8Array }
  | ProtocolQuarantineResult;

export interface RequiredVersionMismatch {
  kind: 'protocol' | 'payload';
  path: string;
  expected: number;
  observed: unknown;
}

export interface VersionedProtocolDescriptor<T extends TSchema> {
  protocol: string;
  protocolVersion: number;
  payloadVersion: number;
  schema: T;
  validateInvariants?: (value: Static<T>) => readonly ProtocolValidationIssue[];
  findUnsupportedRequiredVersion?: (
    value: Readonly<Record<string, unknown>>,
  ) => RequiredVersionMismatch | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

export function quarantineProtocolBytes(
  rawBytes: Uint8Array,
  reason: ProtocolQuarantineReason,
  message: string,
  details: Omit<ProtocolQuarantineResult, 'ok' | 'disposition' | 'reason' | 'message' | 'rawBytes'> = {},
): ProtocolQuarantineResult {
  return {
    ok: false,
    disposition: 'quarantine',
    reason,
    message,
    rawBytes: new Uint8Array(rawBytes),
    ...details,
  };
}

export function decodeVersionedProtocol<T extends TSchema>(
  bytes: Uint8Array,
  descriptor: VersionedProtocolDescriptor<T>,
): VersionedProtocolDecodeResult<Static<T>> {
  const decoded = decodeCanonicalCbor(bytes);
  if (!decoded.ok) {
    return quarantineProtocolBytes(bytes, decoded.reason, decoded.message);
  }
  if (!isRecord(decoded.value)) {
    return quarantineProtocolBytes(bytes, 'schema-invalid', 'protocol envelope must be a map', {
      path: '$',
    });
  }

  if (decoded.value.protocol !== descriptor.protocol) {
    return quarantineProtocolBytes(
      bytes,
      'unexpected-protocol',
      `expected protocol ${descriptor.protocol}`,
      {
        path: '/protocol',
        expected: descriptor.protocol,
        observed: decoded.value.protocol,
      },
    );
  }
  if (decoded.value.protocolVersion !== descriptor.protocolVersion) {
    return quarantineProtocolBytes(
      bytes,
      'unsupported-protocol-version',
      `protocol version ${String(decoded.value.protocolVersion)} is not supported`,
      {
        path: '/protocolVersion',
        expected: descriptor.protocolVersion,
        observed: decoded.value.protocolVersion,
      },
    );
  }
  if (decoded.value.payloadVersion !== descriptor.payloadVersion) {
    return quarantineProtocolBytes(
      bytes,
      'unsupported-payload-version',
      `payload version ${String(decoded.value.payloadVersion)} is not supported`,
      {
        path: '/payloadVersion',
        expected: descriptor.payloadVersion,
        observed: decoded.value.payloadVersion,
      },
    );
  }

  const nestedVersion = descriptor.findUnsupportedRequiredVersion?.(decoded.value);
  if (nestedVersion) {
    const reason =
      nestedVersion.kind === 'protocol'
        ? 'unsupported-protocol-version'
        : 'unsupported-payload-version';
    return quarantineProtocolBytes(
      bytes,
      reason,
      `${nestedVersion.kind} version ${String(nestedVersion.observed)} is not supported`,
      {
        path: nestedVersion.path,
        expected: nestedVersion.expected,
        observed: nestedVersion.observed,
      },
    );
  }

  const validated = validateSchema(descriptor.schema, decoded.value);
  if (!validated.ok) {
    return quarantineProtocolBytes(bytes, 'schema-invalid', 'protocol schema validation failed', {
      issues: validated.issues,
    });
  }
  const invariantIssues = descriptor.validateInvariants?.(validated.value) ?? [];
  if (invariantIssues.length > 0) {
    return quarantineProtocolBytes(bytes, 'invariant-invalid', 'protocol invariants failed', {
      issues: invariantIssues,
    });
  }
  return { ok: true, value: validated.value, canonicalBytes: decoded.canonicalBytes };
}

export function encodeVersionedProtocol<T extends TSchema>(
  value: Static<T>,
  descriptor: VersionedProtocolDescriptor<T>,
): Uint8Array {
  const validated = validateSchema(descriptor.schema, value);
  if (!validated.ok) {
    const detail = validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new TypeError(`protocol schema validation failed: ${detail}`);
  }
  const invariantIssues = descriptor.validateInvariants?.(validated.value) ?? [];
  if (invariantIssues.length > 0) {
    const detail = invariantIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new TypeError(`protocol invariants failed: ${detail}`);
  }
  return encodeCanonicalCbor(validated.value as CanonicalCborValue);
}
