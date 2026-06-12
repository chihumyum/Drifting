/**
 * Entity snapshot history — the local time-machine trail (see the
 * EntitySnapshotHistoryTable comment in schema/drizzle.ts). Rows are written
 * by snapshot-history.service at most every 15 min per entity, thinned to
 * hourly-today / daily-older, and dropped after 30 days.
 */
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { EntitySnapshotHistoryTable } from '../schema/drizzle';
import type { ProseEntityType } from '../lib/yjs-doc-id';

export interface EntitySnapshotRow {
  id: string;
  projectId: string;
  entityKind: ProseEntityType;
  entityId: string;
  stateBlob: Uint8Array;
  contentJson: string | null;
  metaJson: string | null;
  createdAt: string;
}

/** List view — everything but the (potentially large) state blob. */
export type EntitySnapshotSummary = Omit<EntitySnapshotRow, 'stateBlob'>;

export interface EntitySnapshotRepository {
  insert(row: EntitySnapshotRow): Promise<void>;
  /** Newest first. Blob omitted — fetch it via getById on restore. */
  listForEntity(entityKind: ProseEntityType, entityId: string): Promise<EntitySnapshotSummary[]>;
  getById(id: string): Promise<EntitySnapshotRow | null>;
  /** The newest snapshot row for an entity (blob included, for dedup checks). */
  getLatestForEntity(
    entityKind: ProseEntityType,
    entityId: string,
  ): Promise<EntitySnapshotRow | null>;
  deleteByIds(ids: string[]): Promise<void>;
  /** Drop all rows older than the cutoff (ISO string). Returns rows pruned. */
  deleteOlderThan(cutoffIso: string): Promise<number>;
  deleteForEntity(entityKind: ProseEntityType, entityId: string): Promise<void>;
}

function normalizeBlob(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input === 'object') {
    const maybeBuffer = input as { type?: string; data?: number[] };
    if (maybeBuffer.type === 'Buffer' && Array.isArray(maybeBuffer.data)) {
      return Uint8Array.from(maybeBuffer.data);
    }
  }
  throw new Error('Unsupported blob format when reading entity snapshot');
}

function toRow(row: typeof EntitySnapshotHistoryTable.$inferSelect): EntitySnapshotRow {
  return {
    id: row.id,
    projectId: row.projectId,
    entityKind: row.entityKind as ProseEntityType,
    entityId: row.entityId,
    stateBlob: normalizeBlob(row.stateBlob),
    contentJson: row.contentJson,
    metaJson: row.metaJson,
    createdAt: row.createdAt,
  };
}

export function createEntitySnapshotRepository(): EntitySnapshotRepository {
  return {
    async insert(row) {
      await getDb()
        .insert(EntitySnapshotHistoryTable)
        .values({ ...row, stateBlob: new Uint8Array(row.stateBlob) });
    },

    async listForEntity(entityKind, entityId) {
      const rows = await getDb()
        .select({
          id: EntitySnapshotHistoryTable.id,
          projectId: EntitySnapshotHistoryTable.projectId,
          entityKind: EntitySnapshotHistoryTable.entityKind,
          entityId: EntitySnapshotHistoryTable.entityId,
          contentJson: EntitySnapshotHistoryTable.contentJson,
          metaJson: EntitySnapshotHistoryTable.metaJson,
          createdAt: EntitySnapshotHistoryTable.createdAt,
        })
        .from(EntitySnapshotHistoryTable)
        .where(
          and(
            eq(EntitySnapshotHistoryTable.entityKind, entityKind),
            eq(EntitySnapshotHistoryTable.entityId, entityId),
          ),
        )
        .orderBy(desc(EntitySnapshotHistoryTable.createdAt));
      return rows.map((r) => ({ ...r, entityKind: r.entityKind as ProseEntityType }));
    },

    async getById(id) {
      const rows = await getDb()
        .select()
        .from(EntitySnapshotHistoryTable)
        .where(eq(EntitySnapshotHistoryTable.id, id))
        .limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },

    async getLatestForEntity(entityKind, entityId) {
      const rows = await getDb()
        .select()
        .from(EntitySnapshotHistoryTable)
        .where(
          and(
            eq(EntitySnapshotHistoryTable.entityKind, entityKind),
            eq(EntitySnapshotHistoryTable.entityId, entityId),
          ),
        )
        .orderBy(desc(EntitySnapshotHistoryTable.createdAt))
        .limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },

    async deleteByIds(ids) {
      if (ids.length === 0) return;
      await getDb()
        .delete(EntitySnapshotHistoryTable)
        .where(inArray(EntitySnapshotHistoryTable.id, ids));
    },

    async deleteOlderThan(cutoffIso) {
      const deleted = await getDb()
        .delete(EntitySnapshotHistoryTable)
        .where(lt(EntitySnapshotHistoryTable.createdAt, cutoffIso))
        .returning({ id: EntitySnapshotHistoryTable.id });
      return deleted.length;
    },

    async deleteForEntity(entityKind, entityId) {
      await getDb()
        .delete(EntitySnapshotHistoryTable)
        .where(
          and(
            eq(EntitySnapshotHistoryTable.entityKind, entityKind),
            eq(EntitySnapshotHistoryTable.entityId, entityId),
          ),
        );
    },
  };
}
