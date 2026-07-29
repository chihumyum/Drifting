/**
 * Origin attached only after a Yjs update and its command receipt have already
 * committed to SQLite. The live document session uses it to advance its
 * compaction coverage cursor without appending the same update a second time.
 *
 * Other live-document listeners intentionally still see this as a local
 * change: they may schedule server push/materialization, both of which consume
 * the already-durable update log.
 */
export interface PersistedYjsUpdateOrigin {
  kind: 'drifting.persisted-yjs-update';
  updateId: number;
  receiptId: string;
}

export function createPersistedYjsUpdateOrigin(
  updateId: number,
  receiptId: string,
): PersistedYjsUpdateOrigin {
  if (!Number.isSafeInteger(updateId) || updateId <= 0) {
    throw new Error('Persisted Yjs update id must be a positive safe integer');
  }
  if (!receiptId.trim()) {
    throw new Error('Persisted Yjs receipt id must be non-empty');
  }
  return {
    kind: 'drifting.persisted-yjs-update',
    updateId,
    receiptId,
  };
}

export function readPersistedYjsUpdateOrigin(
  origin: unknown,
): PersistedYjsUpdateOrigin | null {
  if (
    !origin ||
    typeof origin !== 'object' ||
    (origin as { kind?: unknown }).kind !== 'drifting.persisted-yjs-update' ||
    !Number.isSafeInteger((origin as { updateId?: unknown }).updateId) ||
    ((origin as { updateId: number }).updateId <= 0) ||
    typeof (origin as { receiptId?: unknown }).receiptId !== 'string' ||
    !(origin as { receiptId: string }).receiptId.trim()
  ) {
    return null;
  }
  return origin as PersistedYjsUpdateOrigin;
}
