/**
 * Payload v2 form of a checkpoint's authored state: one or more canonical
 * CBOR pages per table, in manifest order, so a large project never exceeds
 * the canonical node limit of a single value.
 */
import {
  decodeCanonicalCbor,
  encodeCanonicalCbor,
  paginateCanonicalEntries,
  type CanonicalCborValue,
} from '../protocol';
import { AUTHORED_STATE_FORMAT_V1, SnapshotRestoreError, type SnapshotTableRowsV1 } from './types';

export const AUTHORED_STATE_PAGES_PAYLOAD_VERSION = 2 as const;

// Envelope nodes: the page map, its four values and the rows array.
const PAGE_OVERHEAD = 6;

export function encodeAuthoredStatePagesV2(tables: readonly SnapshotTableRowsV1[]): Uint8Array[] {
  const pages: Uint8Array[] = [];
  for (const { table, rows } of tables) {
    const chunks = paginateCanonicalEntries(rows as CanonicalCborValue[], PAGE_OVERHEAD);
    for (const chunk of chunks.length > 0 ? chunks : [[]]) {
      pages.push(encodeCanonicalCbor({
        format: AUTHORED_STATE_FORMAT_V1,
        payloadVersion: AUTHORED_STATE_PAGES_PAYLOAD_VERSION,
        table,
        rows: chunk,
      }));
    }
  }
  return pages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

/** Rejoins consecutive pages of a table; table order is validated by the caller. */
export function decodeAuthoredStatePagesV2(pages: readonly Uint8Array[]): SnapshotTableRowsV1[] {
  const tables: { table: string; rows: Readonly<Record<string, CanonicalCborValue>>[] }[] = [];
  const seen = new Set<string>();
  for (const [index, bytes] of pages.entries()) {
    const decoded = decodeCanonicalCbor(bytes);
    if (!decoded.ok || !isRecord(decoded.value)) {
      throw new SnapshotRestoreError('invalid-package', `Authored page ${index} is not current deterministic CBOR`);
    }
    const { format, payloadVersion, table, rows } = decoded.value;
    if (
      format !== AUTHORED_STATE_FORMAT_V1 ||
      payloadVersion !== AUTHORED_STATE_PAGES_PAYLOAD_VERSION ||
      typeof table !== 'string' ||
      !Array.isArray(rows) ||
      !rows.every(isRecord)
    ) {
      throw new SnapshotRestoreError('schema-mismatch', `Authored page ${index} is malformed`);
    }
    const last = tables[tables.length - 1];
    if (last?.table === table) {
      if (rows.length === 0) throw new SnapshotRestoreError('schema-mismatch', `Authored page ${index} is empty`);
      last.rows.push(...(rows as Readonly<Record<string, CanonicalCborValue>>[]));
      continue;
    }
    if (seen.has(table)) throw new SnapshotRestoreError('schema-mismatch', `Authored table ${table} is not contiguous`);
    seen.add(table);
    tables.push({ table, rows: [...(rows as Readonly<Record<string, CanonicalCborValue>>[])] });
  }
  return tables;
}
