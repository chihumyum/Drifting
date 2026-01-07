// operations related to book contents (prosemirror json based for now, yjs later)
import type { BookContent } from '../domain/book_content';
import type { BookContentRecord } from '../schema/book_content';
import type { BookContentRepository } from './book_content';
import { v7 as uuidv7 } from 'uuid';
import { run, query } from '../lib/db';
import type { SyncStatus } from '../lib/sync/types';


export function recordToBookContent(record: BookContentRecord): BookContent {
  return {
    id: record.id,
    nodeId: record.node_id,
    pmJson: record.pm_json,
    outlineJson: record.outline_json,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function bookContentToRecord(node: BookContent): BookContentRecord {
  return {
    id: node.id,
    node_id: node.nodeId,
    pm_json: node.pmJson,
    outline_json: node.outlineJson,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    sync_status: 'synced',
    last_modified: null,
    is_deleted: 0,
  };
}

async function getContentRecordByNodeId(nodeId: string): Promise<BookContentRecord | null> {
  const rows = await query<BookContentRecord>(`SELECT * FROM book_content WHERE node_id = ?`, [nodeId]);
  return rows.length ? rows[0] : null;
}

export function createBookContentRepository(): BookContentRepository {
    const selectBase = `SELECT bc.* FROM book_content bc`;

    const findById = async (id: string): Promise<BookContent | null> => {
      const result = await query<BookContentRecord>(`${selectBase} WHERE bc.id = ?`, [id]);
      return result.length ? recordToBookContent(result[0]) : null;
    };

    const findByNodeId = async (nodeId: string): Promise<BookContent | null> => {
        const result = await query<BookContentRecord>(`${selectBase} WHERE bc.node_id = ?`, [nodeId]);
        return result.length ? recordToBookContent(result[0]) : null;
    };

    const create = async (data: Partial<BookContent>): Promise<BookContent> => {
      const now = new Date().toISOString();
      const lastModified = Date.now();
      const record: BookContentRecord = {
        id: data.id || uuidv7(),
        node_id: data.nodeId!,
        pm_json: data.pmJson || '',
        outline_json: data.outlineJson || '[]',
        created_at: now,
        updated_at: now,
        sync_status: 'pending',
        last_modified: lastModified,
        is_deleted: 0,
      };
      await run(
        `INSERT OR REPLACE INTO book_content (id, node_id, pm_json, outline_json, created_at, updated_at, sync_status, last_modified, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.node_id,
          record.pm_json,
          record.outline_json,
          record.created_at,
          record.updated_at,
          record.sync_status,
          record.last_modified,
          record.is_deleted,
        ]
      );
      return recordToBookContent(record);
    }

    const update = async (id: string, data: Partial<BookContent>): Promise<BookContent | null> => {
      const now = new Date().toISOString();
      const existing = await findById(id);
      if (!existing) {
        return null;
      }
      const lastModified = Date.now();
      const record: BookContentRecord = {
        id,
        node_id: data.nodeId ?? existing.nodeId,
        pm_json: data.pmJson ?? existing.pmJson,
        outline_json: data.outlineJson ?? existing.outlineJson,
        created_at: existing.createdAt,
        updated_at: now,
        sync_status: 'pending',
        last_modified: lastModified,
        is_deleted: 0,
      };
      await run(
        `UPDATE book_content
         SET node_id = ?, pm_json = ?, outline_json = ?, updated_at = ?, sync_status = 'pending', last_modified = ?, is_deleted = 0
         WHERE id = ?`,
        [record.node_id, record.pm_json, record.outline_json, record.updated_at, record.last_modified, record.id]
      );
      return recordToBookContent(record);
    }
    const updateByNodeId = async (nodeId: string, data: Partial<BookContent>): Promise<BookContent | null> => {
      const existing = await findByNodeId(nodeId);
      if (!existing) {
        return null;
      }
      return update(existing.id, data);
    }

    const deleteById = async (id: string): Promise<boolean> => {
      const changes = await run(`DELETE FROM book_content WHERE id = ?`, [id]);
      return changes > 0;
    }

    const deleteByNodeId = async (nodeId: string): Promise<boolean> => {
      const changes = await run(`DELETE FROM book_content WHERE node_id = ?`, [nodeId]);
      return changes > 0;
    }

    return {
      findById,
      findByNodeId,
      create,
      update,
      updateByNodeId,
      deleteById,
      deleteByNodeId,
    };
}

export async function markContentSyncStatus(
  nodeId: string,
  status: SyncStatus,
  options?: { updatedAt?: string },
): Promise<void> {
  const existing = await getContentRecordByNodeId(nodeId);
  if (!existing) return;

  const updatedAtClause = options?.updatedAt ? `, updated_at = ?` : '';
  const parsedLastModified = options?.updatedAt ? Date.parse(options.updatedAt) : undefined;
  const lastModifiedClause = parsedLastModified && !Number.isNaN(parsedLastModified) ? `, last_modified = ?` : '';

  const params: Array<string | number> = [status];
  if (options?.updatedAt) params.push(options.updatedAt);
  if (parsedLastModified && !Number.isNaN(parsedLastModified)) params.push(parsedLastModified);
  params.push(nodeId);

  await run(
    `UPDATE book_content SET sync_status = ?${updatedAtClause}${lastModifiedClause} WHERE node_id = ?`,
    params,
  );

  if (status === 'synced' && existing.is_deleted === 1) {
    await run(`DELETE FROM book_content WHERE node_id = ?`, [nodeId]);
  }
}

export async function applyRemoteContent(remote: {
  nodeId: string;
  pmJson: string;
  outlineJson: string;
  createdAt: string;
  updatedAt: string;
}): Promise<'inserted' | 'updated' | 'skipped' | 'conflict'> {
  const remoteUpdatedAt = Date.parse(remote.updatedAt);
  if (Number.isNaN(remoteUpdatedAt)) {
    return 'skipped';
  }

  const existing = await getContentRecordByNodeId(remote.nodeId);
  if (!existing) {
    const record: BookContentRecord = {
      id: uuidv7(),
      node_id: remote.nodeId,
      pm_json: remote.pmJson,
      outline_json: remote.outlineJson,
      created_at: remote.createdAt,
      updated_at: remote.updatedAt,
      sync_status: 'synced',
      last_modified: remoteUpdatedAt,
      is_deleted: 0,
    };
    await run(
      `INSERT INTO book_content (id, node_id, pm_json, outline_json, created_at, updated_at, sync_status, last_modified, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.node_id,
        record.pm_json,
        record.outline_json,
        record.created_at,
        record.updated_at,
        record.sync_status,
        record.last_modified,
        record.is_deleted,
      ],
    );
    return 'inserted';
  }

  const localStatus = (existing.sync_status ?? 'synced') as SyncStatus;
  const localLastModified = existing.last_modified ?? 0;
  if (localStatus === 'pending' && localLastModified > remoteUpdatedAt) {
    return 'conflict';
  }

  await run(
    `UPDATE book_content
     SET pm_json = ?, outline_json = ?, updated_at = ?, sync_status = 'synced', last_modified = ?, is_deleted = 0
     WHERE node_id = ?`,
    [remote.pmJson, remote.outlineJson, remote.updatedAt, remoteUpdatedAt, remote.nodeId],
  );
  return 'updated';
}

export async function cleanupSyncedDeletedContents(): Promise<void> {
  await run(`DELETE FROM book_content WHERE is_deleted = 1 AND sync_status = 'synced'`);
}