import { asc, eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';

import { activeTransactionOwner, afterDatabaseCommit, type DbExecutor } from '../../lib/db';
import { yjsSnapshots, yjsUpdates } from '../../schema/drizzle';
import { createYjsRepository, type YjsUpdateRow } from '../../sqlite-repo/yjs-repo';

/**
 * Validating a yjs.update means applying it to the document's stored state.
 * Every keystroke is one such update, and rebuilding a long chapter from its
 * snapshot and whole update log each time (every blob crossing IPC) cost more
 * than the rest of the reducer. A document that exactly matches committed
 * state is therefore kept per database, and the next check reads only the
 * update rows appended since. It is rebuilt when its snapshot, its oldest
 * update row or its revision moved in any other way (compaction, restore,
 * purge).
 *
 * A check takes its document out of the cache. It goes back only when the
 * update was already a stored row (an authored write appends before the
 * reducer runs) and only after the transaction commits, so the cache never
 * holds an update the database does not.
 */
const MAX_DOCUMENTS = 4;

interface StoredDocument {
  readonly doc: Y.Doc;
  readonly snapshot: string | null;
  readonly firstUpdateId: number | null;
  readonly lastUpdateId: number;
  readonly revision: number;
}

const documentsByDatabase = new WeakMap<object, Map<string, StoredDocument>>();

/** Throws when `update` cannot be applied to `docId`'s stored state. */
export async function applyToStoredYjsDocument(
  tx: DbExecutor,
  docId: string,
  update: Uint8Array,
): Promise<void> {
  const owner = activeTransactionOwner(tx);
  let documents = owner ? documentsByDatabase.get(owner) : undefined;
  if (owner && !documents) documentsByDatabase.set(owner, (documents = new Map()));
  const repository = createYjsRepository(tx);
  const [[snapshotRow], [firstRow], revision] = await Promise.all([
    tx
      .select({ updatedAt: yjsSnapshots.updatedAt, bytes: sql<number>`length(${yjsSnapshots.stateBlob})` })
      .from(yjsSnapshots)
      .where(eq(yjsSnapshots.docId, docId))
      .limit(1),
    tx
      .select({ id: yjsUpdates.id })
      .from(yjsUpdates)
      .where(eq(yjsUpdates.docId, docId))
      .orderBy(asc(yjsUpdates.id))
      .limit(1),
    repository.getRevision(docId),
  ]);
  const snapshot = snapshotRow ? `${snapshotRow.updatedAt}:${snapshotRow.bytes}` : null;
  const firstUpdateId = firstRow?.id ?? null;
  const cached = documents?.get(docId);
  documents?.delete(docId);

  let rows: YjsUpdateRow[] | null = null;
  if (
    cached
    && cached.snapshot === snapshot
    && (cached.firstUpdateId === null
      ? firstUpdateId === null || firstUpdateId > cached.lastUpdateId
      : cached.firstUpdateId === firstUpdateId)
  ) {
    rows = await repository.listUpdates(docId, cached.lastUpdateId);
    // Every stored row advanced the revision once; anything else moved it.
    if (revision - cached.revision !== rows.length) rows = null;
  }
  const reused = rows !== null && cached !== undefined;
  if (cached && !reused) cached.doc.destroy();
  const doc = reused ? cached.doc : new Y.Doc();
  let lastUpdateId = reused ? cached.lastUpdateId : 0;
  let stored = false;
  try {
    if (!reused) {
      const snapshotState = await repository.getSnapshot(docId);
      if (snapshotState) Y.applyUpdate(doc, snapshotState.stateBlob);
      rows = await repository.listUpdates(docId);
    }
    for (const row of rows!) {
      Y.applyUpdate(doc, row.updateBlob);
      lastUpdateId = row.id;
    }
    stored = sameBytes(rows![rows!.length - 1]?.updateBlob, update);
    if (!stored) Y.applyUpdate(doc, update);
  } catch (error) {
    doc.destroy();
    throw error;
  }
  if (!owner || !documents || !stored) {
    doc.destroy();
    return;
  }
  const entry: StoredDocument = { doc, snapshot, firstUpdateId, lastUpdateId, revision };
  const cache = documents;
  afterDatabaseCommit(tx, () => {
    const previous = cache.get(docId);
    if (previous && previous.doc !== doc) previous.doc.destroy();
    cache.delete(docId);
    cache.set(docId, entry);
    for (const [oldestId, oldest] of cache) {
      if (cache.size <= MAX_DOCUMENTS) break;
      cache.delete(oldestId);
      oldest.doc.destroy();
    }
  });
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
