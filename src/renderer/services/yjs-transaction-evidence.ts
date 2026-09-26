import * as Y from 'yjs';

import { readPersistedYjsUpdateOrigin } from '../lib/yjs-persistence-origin';
import {
  parseYjsUpdatePayload,
  type ParsedYjsUpdatePayload,
  type YjsTransactionDeleteRange,
  YJS_SOURCE_RETENTION_MAX_SNAPSHOT_BYTES,
  YJS_TRANSACTION_MAX_DELETE_RANGES,
} from '../sync/protocol/yjs-update-payload';

export type YjsTransactionEvidenceResult =
  | { readonly status: 'captured'; readonly payload: ParsedYjsUpdatePayload }
  | { readonly status: 'unavailable'; readonly update: Uint8Array; readonly error: Error };

export interface YjsTransactionEvidenceCapture {
  /** Transfer the captured records to the caller, including every failure. */
  drain(): YjsTransactionEvidenceResult[];
  /** Stop observing. Records already captured remain available to drain. */
  dispose(): void;
}

type Basis = { snapshot: Uint8Array } | { error: Error };

function asError(error: unknown): Error {
  try {
    return error instanceof Error ? error : new Error(String(error));
  } catch {
    return new Error('Transaction evidence capture failed with an unreadable error');
  }
}

function requireTransactionStart(
  transaction: Y.Transaction,
  stateVector: ReadonlyMap<number, number>,
  message: string,
): void {
  if (
    transaction.deleteSet.clients.size !== 0 ||
    stateVector.size !== transaction.beforeState.size ||
    [...stateVector].some(([client, clock]) => transaction.beforeState.get(client) !== clock)
  ) {
    throw new Error(message);
  }
}

/**
 * Capture neutral facts from actual local Yjs update events. This is not an
 * authored-deletion certificate: structural editing also deletes Yjs items,
 * and an observer-created transaction may already appear in an earlier
 * event's update bytes. The delete ranges come only from that event's fourth
 * argument, never from decoding the update's accumulated DeleteSet.
 *
 * The predicate is an explicit, synchronous, read-only eligibility decision at
 * transaction start. Prior listener writes or predicate writes make the basis
 * unavailable; neither may be misreported as the transaction's before-state.
 * Remote applyUpdate (including one nested in an otherwise local
 * transaction) and already-persisted origins are always excluded. Install this
 * before starting the transactions whose evidence is needed.
 *
 * No caller callback runs inside Yjs cleanup. Capture failures are queued as
 * unavailable records with the original update bytes; they are not silently
 * downgraded to usable provenance. The caller must drain, handle errors and own
 * durable write/retry failures. Neither capture nor disposal rolls back Yjs.
 */
export function captureYjsTransactionEvidence(
  doc: Y.Doc,
  allowTransaction: (transaction: Y.Transaction, origin: unknown) => boolean,
): YjsTransactionEvidenceCapture {
  let bases = new WeakMap<Y.Transaction, Basis>();
  let records: YjsTransactionEvidenceResult[] = [];
  let disposed = false;

  const beforeTransaction = (transaction: Y.Transaction): void => {
    if (!transaction.local) return;
    try {
      if (readPersistedYjsUpdateOrigin(transaction.origin)) return;
      // Earlier beforeTransaction listeners can already have written into this
      // same transaction. Its captured beforeState plus empty transaction DS
      // distinguish the true start, including pure deletes with unchanged SV.
      const before = Y.snapshot(doc);
      requireTransactionStart(transaction, before.sv, 'Transaction changed before evidence capture');
      // Capture before invoking caller code. This contains SV and prior deletion
      // coverage, without copying the document's full content on each edit.
      const snapshot = Y.encodeSnapshot(before);
      const allowed = allowTransaction(transaction, transaction.origin);
      requireTransactionStart(
        transaction,
        Y.decodeStateVector(Y.encodeStateVector(doc)),
        'Transaction evidence predicate must not modify the document',
      );
      if (typeof allowed !== 'boolean') throw new TypeError('Transaction evidence predicate must return a synchronous boolean');
      if (!allowed) return;
      if (snapshot.byteLength > YJS_SOURCE_RETENTION_MAX_SNAPSHOT_BYTES) {
        throw new RangeError('Transaction evidence snapshot exceeds the protocol byte limit');
      }
      bases.set(transaction, { snapshot });
    } catch (error) {
      // beforeTransaction is emitted outside Yjs's transaction try/finally.
      // Throwing here would leave the document's active transaction uncleared.
      bases.set(transaction, { error: asError(error) });
    }
  };

  const update = (bytes: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction): void => {
    const basis = bases.get(transaction);
    bases.delete(transaction);
    // applyUpdate can change transaction.local after beforeTransaction fired.
    if (!basis || !transaction.local) return;
    const copiedUpdate = new Uint8Array(bytes);
    try {
      if (readPersistedYjsUpdateOrigin(origin)) return;
      if ('error' in basis) throw basis.error;
      const transactionDeletes: YjsTransactionDeleteRange[] = [];
      for (const [client, ranges] of transaction.deleteSet.clients) {
        for (const range of ranges) {
          if (transactionDeletes.length >= YJS_TRANSACTION_MAX_DELETE_RANGES) {
            throw new RangeError('Transaction evidence exceeds the protocol delete-range limit');
          }
          transactionDeletes.push({ client, clock: range.clock, length: range.len });
        }
      }
      transactionDeletes.sort((left, right) => left.client - right.client || left.clock - right.clock);
      records.push({
        status: 'captured',
        payload: parseYjsUpdatePayload({
          update: copiedUpdate,
          sourceRetentionProvenance: {
            version: 1,
            kind: 'transaction-event',
            beforeSnapshot: basis.snapshot,
            transactionDeletes,
          },
        }),
      });
    } catch (error) {
      records.push({ status: 'unavailable', update: copiedUpdate, error: asError(error) });
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    doc.off('beforeTransaction', beforeTransaction);
    doc.off('update', update);
    doc.off('destroy', dispose);
    bases = new WeakMap();
  };
  doc.on('beforeTransaction', beforeTransaction);
  doc.on('update', update);
  doc.on('destroy', dispose);
  return {
    drain() {
      const drained = records;
      records = [];
      return drained;
    },
    dispose,
  };
}
