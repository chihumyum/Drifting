import { and, eq } from 'drizzle-orm';

import { getDb, type DbExecutor } from '../lib/db';
import { MarkdownMirrorFileTable } from '../schema/drizzle';

/**
 * One authored file of the project Markdown folder, as this device last saw it
 * (docs/markdown-mirror.md). `baseState` is the Yjs state whose rendering the
 * file holds; an external edit is merged as a peer that last synced there.
 */
export interface MarkdownMirrorFileRow {
  projectId: string;
  docId: string;
  directory: string;
  path: string;
  fileSha256: string;
  baseState: Uint8Array;
  baseFieldsJson: string;
  pending: MarkdownMirrorPendingWrite | null;
  updatedAt: string;
}

/** A write sent to disk and not yet confirmed. */
export interface MarkdownMirrorPendingWrite {
  sha256: string;
  path: string;
  state: Uint8Array;
  fieldsJson: string;
}

export interface MarkdownMirrorRecord {
  path: string;
  fileSha256: string;
  baseState: Uint8Array;
  baseFieldsJson: string;
}

/** A row without its Yjs states, cheap enough to read on every scan. */
export interface MarkdownMirrorFileSummary {
  docId: string;
  directory: string;
  path: string;
  fileSha256: string;
  baseFieldsJson: string;
  pendingSha256: string | null;
  pendingPath: string | null;
}

export interface MarkdownMirrorRepository {
  listByProject(projectId: string): Promise<MarkdownMirrorFileRow[]>;
  listSummaries(projectId: string): Promise<MarkdownMirrorFileSummary[]>;
  get(projectId: string, docId: string): Promise<MarkdownMirrorFileRow | null>;
  /** Record what the file now holds; clears any pending write. */
  record(projectId: string, docId: string, directory: string, value: MarkdownMirrorRecord): Promise<void>;
  setPending(projectId: string, docId: string, directory: string, pending: MarkdownMirrorPendingWrite): Promise<void>;
  /** The pending write reached disk: it becomes the base. */
  confirmPending(projectId: string, docId: string): Promise<boolean>;
  clearPending(projectId: string, docId: string): Promise<void>;
  /**
   * Stop expecting particular bytes: the next write keeps the file under
   * `.drifting/preserved` and replaces it. For edits that cannot merge.
   */
  release(projectId: string, docId: string): Promise<void>;
  remove(projectId: string, docId: string): Promise<void>;
}

function bytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input === 'object') {
    const buffer = input as { type?: string; data?: number[] };
    if (buffer.type === 'Buffer' && Array.isArray(buffer.data)) return Uint8Array.from(buffer.data);
  }
  throw new Error('Unsupported blob format in the Markdown folder ledger');
}

function toRow(record: typeof MarkdownMirrorFileTable.$inferSelect): MarkdownMirrorFileRow {
  const pending =
    record.pendingSha256 && record.pendingPath && record.pendingState && record.pendingFieldsJson
      ? {
          sha256: record.pendingSha256,
          path: record.pendingPath,
          state: bytes(record.pendingState),
          fieldsJson: record.pendingFieldsJson,
        }
      : null;
  return {
    projectId: record.projectId,
    docId: record.docId,
    directory: record.directory,
    path: record.path,
    fileSha256: record.fileSha256,
    baseState: bytes(record.baseState),
    baseFieldsJson: record.baseFieldsJson,
    pending,
    updatedAt: record.updatedAt,
  };
}

const NO_PENDING = {
  pendingSha256: null,
  pendingPath: null,
  pendingState: null,
  pendingFieldsJson: null,
} as const;

export function createMarkdownMirrorRepository(dbOverride?: DbExecutor): MarkdownMirrorRepository {
  const db = (): DbExecutor => dbOverride ?? getDb();
  const key = (projectId: string, docId: string) =>
    and(eq(MarkdownMirrorFileTable.projectId, projectId), eq(MarkdownMirrorFileTable.docId, docId));
  const get = async (projectId: string, docId: string) => {
    const rows = await db().select().from(MarkdownMirrorFileTable).where(key(projectId, docId)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  };
  return {
    async listByProject(projectId) {
      const rows = await db()
        .select()
        .from(MarkdownMirrorFileTable)
        .where(eq(MarkdownMirrorFileTable.projectId, projectId));
      return rows.map(toRow);
    },
    async listSummaries(projectId) {
      return db()
        .select({
          docId: MarkdownMirrorFileTable.docId,
          directory: MarkdownMirrorFileTable.directory,
          path: MarkdownMirrorFileTable.path,
          fileSha256: MarkdownMirrorFileTable.fileSha256,
          baseFieldsJson: MarkdownMirrorFileTable.baseFieldsJson,
          pendingSha256: MarkdownMirrorFileTable.pendingSha256,
          pendingPath: MarkdownMirrorFileTable.pendingPath,
        })
        .from(MarkdownMirrorFileTable)
        .where(eq(MarkdownMirrorFileTable.projectId, projectId));
    },
    get,
    async record(projectId, docId, directory, value) {
      const now = new Date().toISOString();
      const fields = {
        directory,
        path: value.path,
        fileSha256: value.fileSha256,
        baseState: value.baseState,
        baseFieldsJson: value.baseFieldsJson,
        ...NO_PENDING,
        updatedAt: now,
      };
      await db()
        .insert(MarkdownMirrorFileTable)
        .values({ projectId, docId, ...fields })
        .onConflictDoUpdate({
          target: [MarkdownMirrorFileTable.projectId, MarkdownMirrorFileTable.docId],
          set: fields,
        });
    },
    async setPending(projectId, docId, directory, pending) {
      const now = new Date().toISOString();
      const values = {
        pendingSha256: pending.sha256,
        pendingPath: pending.path,
        pendingState: pending.state,
        pendingFieldsJson: pending.fieldsJson,
        updatedAt: now,
      };
      const existing = await get(projectId, docId);
      if (existing && existing.directory === directory) {
        await db().update(MarkdownMirrorFileTable).set(values).where(key(projectId, docId));
        return;
      }
      // A file Drifting never recorded here: until the write is confirmed,
      // the pending bytes are the only thing it knows about this path.
      await db()
        .insert(MarkdownMirrorFileTable)
        .values({
          projectId,
          docId,
          directory,
          path: pending.path,
          fileSha256: '',
          baseState: pending.state,
          baseFieldsJson: pending.fieldsJson,
          ...values,
        })
        .onConflictDoUpdate({
          target: [MarkdownMirrorFileTable.projectId, MarkdownMirrorFileTable.docId],
          set: {
            directory,
            path: pending.path,
            fileSha256: '',
            baseState: pending.state,
            baseFieldsJson: pending.fieldsJson,
            ...values,
          },
        });
    },
    async confirmPending(projectId, docId) {
      const row = await get(projectId, docId);
      if (!row?.pending) return false;
      await db()
        .update(MarkdownMirrorFileTable)
        .set({
          path: row.pending.path,
          fileSha256: row.pending.sha256,
          baseState: row.pending.state,
          baseFieldsJson: row.pending.fieldsJson,
          ...NO_PENDING,
          updatedAt: new Date().toISOString(),
        })
        .where(key(projectId, docId));
      return true;
    },
    async clearPending(projectId, docId) {
      await db()
        .update(MarkdownMirrorFileTable)
        .set({ ...NO_PENDING, updatedAt: new Date().toISOString() })
        .where(key(projectId, docId));
    },
    async release(projectId, docId) {
      await db()
        .update(MarkdownMirrorFileTable)
        .set({ fileSha256: '', ...NO_PENDING, updatedAt: new Date().toISOString() })
        .where(key(projectId, docId));
    },
    async remove(projectId, docId) {
      await db().delete(MarkdownMirrorFileTable).where(key(projectId, docId));
    },
  };
}
