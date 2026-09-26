import * as Y from 'yjs';

export interface YjsTransactionDeleteRange {
  readonly client: number;
  readonly clock: number;
  readonly length: number;
}

/** Captured transaction facts, not proof of authored deletion intent. */
export type YjsSourceRetentionProvenanceV1 =
  | {
      readonly version: 1;
      readonly kind: 'transaction-event';
      readonly beforeSnapshot: Uint8Array;
      readonly transactionDeletes: readonly YjsTransactionDeleteRange[];
    }
  | { readonly version: 1; readonly kind: 'state-transfer' };

export interface ParsedYjsUpdatePayload {
  readonly update: Uint8Array;
  readonly sourceRetentionProvenance?: YjsSourceRetentionProvenanceV1;
}

export const YJS_SOURCE_RETENTION_MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const YJS_TRANSACTION_MAX_DELETE_RANGES = 100_000;
const MAX_CLOCK = 0xffff_ffff;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw new TypeError(`${path} must contain exactly ${expected.join(', ')}`);
  }
}

function snapshot(value: unknown): Uint8Array {
  const path = 'sourceRetentionProvenance.beforeSnapshot';
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > YJS_SOURCE_RETENTION_MAX_SNAPSHOT_BYTES) {
    throw new TypeError(`${path} must be non-empty bytes of at most ${YJS_SOURCE_RETENTION_MAX_SNAPSHOT_BYTES} bytes`);
  }
  const copy = new Uint8Array(value);
  let encoded: Uint8Array;
  try {
    encoded = Y.encodeSnapshot(Y.decodeSnapshot(copy));
  } catch {
    throw new TypeError(`${path} must be a valid Yjs v1 snapshot`);
  }
  if (encoded.byteLength !== copy.byteLength || encoded.some((byte, index) => byte !== copy[index])) {
    throw new TypeError(`${path} must round-trip exactly as a Yjs v1 snapshot`);
  }
  return copy;
}

function deleteRanges(value: unknown): readonly YjsTransactionDeleteRange[] {
  const path = 'sourceRetentionProvenance.transactionDeletes';
  if (!Array.isArray(value) || value.length > YJS_TRANSACTION_MAX_DELETE_RANGES) {
    throw new TypeError(`${path} must be an array of at most ${YJS_TRANSACTION_MAX_DELETE_RANGES} ranges`);
  }
  const copied: YjsTransactionDeleteRange[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rangePath = `${path}[${index}]`;
    const range = record(value[index], rangePath);
    exactKeys(range, ['client', 'clock', 'length'], rangePath);
    const { client, clock, length } = range;
    if (typeof client !== 'number' || !Number.isSafeInteger(client) || client < 0) {
      throw new TypeError(`${rangePath}.client must be a non-negative safe integer`);
    }
    if (typeof clock !== 'number' || !Number.isInteger(clock) || clock < 0 || clock > MAX_CLOCK) {
      throw new TypeError(`${rangePath}.clock must be a u32 integer`);
    }
    if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0 || length > MAX_CLOCK || clock + length > MAX_CLOCK) {
      throw new TypeError(`${rangePath}.length must be positive with clock + length <= ${MAX_CLOCK}`);
    }
    const previous = copied[index - 1];
    if (previous && (client < previous.client || (client === previous.client && clock < previous.clock + previous.length))) {
      throw new TypeError(`${path} must be sorted by client and clock without overlapping ranges`);
    }
    // Adjacent ranges are valid. Preserve captured segmentation instead of
    // inventing a different transaction representation while parsing.
    copied.push({ client, clock, length });
  }
  return copied;
}

function provenance(value: unknown): YjsSourceRetentionProvenanceV1 {
  const path = 'sourceRetentionProvenance';
  const source = record(value, path);
  if (source.version !== 1) throw new TypeError(`${path}.version must be supported version 1`);
  if (source.kind === 'state-transfer') {
    exactKeys(source, ['version', 'kind'], path);
    return { version: 1, kind: 'state-transfer' };
  }
  if (source.kind === 'transaction-event') {
    exactKeys(source, ['version', 'kind', 'beforeSnapshot', 'transactionDeletes'], path);
    return {
      version: 1,
      kind: 'transaction-event',
      beforeSnapshot: snapshot(source.beforeSnapshot),
      transactionDeletes: deleteRanges(source.transactionDeletes),
    };
  }
  throw new TypeError(`${path}.kind must be transaction-event or state-transfer`);
}

/**
 * Extract known fields without rewriting the original wire payload. Unknown
 * top-level fields retain legacy read compatibility; present provenance is
 * always validated and can never silently downgrade to a legacy update.
 */
export function parseYjsUpdatePayload(value: unknown): ParsedYjsUpdatePayload {
  const payload = record(value, 'Yjs update payload');
  if (!(payload.update instanceof Uint8Array) || payload.update.byteLength === 0) {
    throw new TypeError('Yjs update payload.update must be non-empty Uint8Array bytes');
  }
  return {
    update: new Uint8Array(payload.update),
    ...('sourceRetentionProvenance' in payload
      ? { sourceRetentionProvenance: provenance(payload.sourceRetentionProvenance) }
      : {}),
  };
}
