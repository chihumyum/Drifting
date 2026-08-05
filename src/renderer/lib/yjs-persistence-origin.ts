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
  /** Exact General Agent collaborator whose certified command produced this
   * CRDT update. Manual/non-Agent updates omit it. */
  collaborator?: PersistedYjsUpdateCollaborator;
}

export interface PersistedYjsUpdateCollaborator {
  kind: 'agent';
  sessionId: string;
  turnId: string;
  callId: string;
}

export function createPersistedYjsUpdateOrigin(
  updateId: number,
  receiptId: string,
  collaborator?: PersistedYjsUpdateCollaborator,
): PersistedYjsUpdateOrigin {
  if (!Number.isSafeInteger(updateId) || updateId <= 0) {
    throw new Error('Persisted Yjs update id must be a positive safe integer');
  }
  if (!receiptId.trim()) {
    throw new Error('Persisted Yjs receipt id must be non-empty');
  }
  if (collaborator && !isPersistedYjsUpdateCollaborator(collaborator)) {
    throw new Error('Persisted Yjs collaborator identity is invalid');
  }
  return {
    kind: 'drifting.persisted-yjs-update',
    updateId,
    receiptId,
    ...(collaborator ? { collaborator: { ...collaborator } } : {}),
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
    !(origin as { receiptId: string }).receiptId.trim() ||
    ('collaborator' in origin &&
      (origin as { collaborator?: unknown }).collaborator !== undefined &&
      !isPersistedYjsUpdateCollaborator((origin as { collaborator: unknown }).collaborator))
  ) {
    return null;
  }
  return origin as PersistedYjsUpdateOrigin;
}

function isPersistedYjsUpdateCollaborator(
  value: unknown,
): value is PersistedYjsUpdateCollaborator {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'agent' &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    Boolean((value as { sessionId: string }).sessionId.trim()) &&
    typeof (value as { turnId?: unknown }).turnId === 'string' &&
    Boolean((value as { turnId: string }).turnId.trim()) &&
    typeof (value as { callId?: unknown }).callId === 'string' &&
    Boolean((value as { callId: string }).callId.trim())
  );
}
