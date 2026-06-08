import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { yjsSnapshots, yjsUpdates } from '../schema/drizzle';

export interface YjsUpdateRow {
  id: number;
  docId: string;
  updateBlob: Uint8Array;
  createdAt: string;
}

export interface YjsSnapshotRow {
  docId: string;
  stateBlob: Uint8Array;
  updatedAt: string;
}

export interface YjsRepository {
  listUpdates(docId: string, sinceId?: number): Promise<YjsUpdateRow[]>;
  appendUpdate(docId: string, updateBlob: Uint8Array): Promise<number>;
  getSnapshot(docId: string): Promise<YjsSnapshotRow | null>;
  upsertSnapshot(docId: string, stateBlob: Uint8Array): Promise<void>;
  hasDocState(docId: string): Promise<boolean>;
  /** Highest update id currently stored for this doc, or 0 if none. */
  maxUpdateId(docId: string): Promise<number>;
  /**
   * Delete update rows with id <= maxId for this doc. Used by compaction
   * once a snapshot has absorbed (and, when syncing, the server has durably
   * received) those updates. Returns the number of rows pruned.
   */
  deleteUpdatesUpTo(docId: string, maxId: number): Promise<number>;
}

function normalizeBlob(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) {
    return Uint8Array.from(input);
  }
  if (input && typeof input === 'object') {
    const maybeBuffer = input as { type?: string; data?: number[] };
    if (maybeBuffer.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
      return Uint8Array.from(maybeBuffer.data);
    }
  }
  throw new Error('Unsupported blob format when reading yjs data');
}

export function createYjsRepository(): YjsRepository {
  const listUpdates = async (docId: string, sinceId?: number): Promise<YjsUpdateRow[]> => {
    const rows =
      sinceId === undefined
        ? await getDb()
            .select()
            .from(yjsUpdates)
            .where(eq(yjsUpdates.docId, docId))
            .orderBy(asc(yjsUpdates.id))
        : await getDb()
            .select()
            .from(yjsUpdates)
            .where(and(eq(yjsUpdates.docId, docId), gt(yjsUpdates.id, sinceId)))
            .orderBy(asc(yjsUpdates.id));

    return rows.map((row) => ({
      id: row.id,
      docId: row.docId,
      updateBlob: normalizeBlob(row.updateBlob),
      createdAt: row.createdAt,
    }));
  };

  const appendUpdate = async (docId: string, updateBlob: Uint8Array): Promise<number> => {
    const now = new Date().toISOString();
    const inserted = await getDb()
      .insert(yjsUpdates)
      .values({
        docId,
        updateBlob: new Uint8Array(updateBlob),
        createdAt: now,
      })
      .returning({ id: yjsUpdates.id });

    if (!inserted[0]) {
      throw new Error(`Failed to append yjs update for doc ${docId}`);
    }
    return inserted[0].id;
  };

  const getSnapshot = async (docId: string): Promise<YjsSnapshotRow | null> => {
    const rows = await getDb()
      .select()
      .from(yjsSnapshots)
      .where(eq(yjsSnapshots.docId, docId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      docId: row.docId,
      stateBlob: normalizeBlob(row.stateBlob),
      updatedAt: row.updatedAt,
    };
  };

  const upsertSnapshot = async (docId: string, stateBlob: Uint8Array): Promise<void> => {
    const now = new Date().toISOString();
    await getDb()
      .insert(yjsSnapshots)
      .values({
        docId,
        stateBlob: new Uint8Array(stateBlob),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: yjsSnapshots.docId,
        set: {
          stateBlob: new Uint8Array(stateBlob),
          updatedAt: now,
        },
      });
  };

  const hasDocState = async (docId: string): Promise<boolean> => {
    const [snap, latestUpdate] = await Promise.all([
      getSnapshot(docId),
      getDb()
        .select({ id: yjsUpdates.id })
        .from(yjsUpdates)
        .where(eq(yjsUpdates.docId, docId))
        .limit(1),
    ]);

    return Boolean(snap || latestUpdate[0]);
  };

  const maxUpdateId = async (docId: string): Promise<number> => {
    const rows = await getDb()
      .select({ id: yjsUpdates.id })
      .from(yjsUpdates)
      .where(eq(yjsUpdates.docId, docId))
      .orderBy(desc(yjsUpdates.id))
      .limit(1);
    return rows[0]?.id ?? 0;
  };

  const deleteUpdatesUpTo = async (docId: string, maxId: number): Promise<number> => {
    if (maxId <= 0) return 0;
    const deleted = await getDb()
      .delete(yjsUpdates)
      .where(and(eq(yjsUpdates.docId, docId), lte(yjsUpdates.id, maxId)))
      .returning({ id: yjsUpdates.id });
    return deleted.length;
  };

  return {
    listUpdates,
    appendUpdate,
    getSnapshot,
    upsertSnapshot,
    hasDocState,
    maxUpdateId,
    deleteUpdatesUpTo,
  };
}
