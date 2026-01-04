import { query, run } from '../lib/db';
import type { StoryThreadRepository } from './story_thread';
import type { StoryThread, CreateStoryThreadInput, UpdateStoryThreadInput } from '../domain/story_thread';
import type { StoryThreadRecord } from '../schema/story_thread';
import { TABLES } from '../schema/table';
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';

const esc = (v: string) => v.replaceAll("'", "''");

const canSync = () => {
  const { isAuthenticated } = useAuthStore.getState();
  return isAuthenticated && navigator.onLine;
};

type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed';

interface SyncMetadata {
  syncStatus: SyncStatus;
  lastModified: number;
  isDeleted: number;
}

const ensureSyncMetadata = (metadata?: Partial<SyncMetadata>): SyncMetadata => ({
  syncStatus: metadata?.syncStatus ?? 'synced',
  lastModified: metadata?.lastModified ?? Date.now(),
  isDeleted: metadata?.isDeleted ?? 0,
});

const parsePmJson = (json: string | null | undefined): object | undefined => {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch (error) {
    console.warn('[StoryThreadRepository] Failed to parse pm_json:', error);
    return undefined;
  }
};

const recordToDomain = (record: StoryThreadRecord): StoryThread => ({
  id: record.id,
  projectId: record.project_id,
  name: record.name,
  color: record.color,
  summary: record.summary || undefined,
  pmJson: parsePmJson(record.pm_json),
  createdAt: new Date(record.created_at),
  updatedAt: new Date(record.updated_at),
});

const ensureThreadRecord = (record: StoryThreadRecord): StoryThreadRecord & Required<Pick<StoryThreadRecord, 'sync_status' | 'last_modified' | 'is_deleted'>> => ({
  ...record,
  sync_status: record.sync_status ?? 'synced',
  last_modified: record.last_modified ?? (Date.parse(record.updated_at) || Date.now()),
  is_deleted: record.is_deleted ?? 0,
});

const getThreadRecordById = async (id: string) => {
  const rows = await query<StoryThreadRecord & { sync_status?: SyncStatus; last_modified?: number | null; is_deleted?: number }>(
    `SELECT * FROM ${TABLES.storyThread} WHERE id='${esc(id)}' LIMIT 1`
  );
  return rows[0] ? ensureThreadRecord(rows[0]) : undefined;
};

const insertThreadRecord = async (record: StoryThreadRecord, metadata?: Partial<SyncMetadata>) => {
  const sync = ensureSyncMetadata(metadata);
  await run(
    `INSERT INTO ${TABLES.storyThread}
     (id, project_id, name, color, summary, pm_json, created_at, updated_at, sync_status, last_modified, is_deleted)
     VALUES (
       '${esc(record.id)}',
       '${esc(record.project_id)}',
       '${esc(record.name)}',
       '${esc(record.color)}',
       ${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
       ${record.pm_json ? `'${esc(record.pm_json)}'` : 'NULL'},
       '${esc(record.created_at)}',
       '${esc(record.updated_at)}',
       '${sync.syncStatus}',
       ${sync.lastModified},
       ${sync.isDeleted}
     )`
  );
};

const updateThreadRecord = async (record: StoryThreadRecord, metadata?: Partial<SyncMetadata>) => {
  const sync = ensureSyncMetadata(metadata);
  await run(
    `UPDATE ${TABLES.storyThread} SET
       project_id='${esc(record.project_id)}',
       name='${esc(record.name)}',
       color='${esc(record.color)}',
       summary=${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
       pm_json=${record.pm_json ? `'${esc(record.pm_json)}'` : 'NULL'},
       created_at='${esc(record.created_at)}',
       updated_at='${esc(record.updated_at)}',
       sync_status='${sync.syncStatus}',
       last_modified=${sync.lastModified},
       is_deleted=${sync.isDeleted}
     WHERE id='${esc(record.id)}'`
  );
};

export class StoryThreadSQLiteRepository implements StoryThreadRepository {
  async createThread(input: CreateStoryThreadInput): Promise<StoryThread> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const lastModified = Date.now();

    const record: StoryThreadRecord = {
      id,
      project_id: input.projectId,
      name: input.name,
      color: input.color,
      summary: input.summary || null,
      pm_json: input.pmJson ? JSON.stringify(input.pmJson) : null,
      created_at: now,
      updated_at: now,
      sync_status: 'pending',
      last_modified: lastModified,
      is_deleted: 0,
    };

    await insertThreadRecord(record, {
      syncStatus: 'pending',
      lastModified,
      isDeleted: 0,
    });

    if (canSync()) {
      syncManager.enqueue({
        type: 'create',
        entity: 'thread',
        localId: id,
        projectId: input.projectId,
        data: {
          id,
          name: input.name,
          color: input.color,
          summary: input.summary,
          pmJson: input.pmJson,
          nodeIds: [],
        },
        priority: 'normal',
      });
    }

    return recordToDomain(record);
  }

  async getThreadById(id: string): Promise<StoryThread | null> {
    const records = await query<StoryThreadRecord>(
      `SELECT * FROM ${TABLES.storyThread} WHERE id = '${esc(id)}' AND is_deleted = 0`
    );
    return records.length > 0 ? recordToDomain(records[0]) : null;
  }

  async getThreadsByProject(projectId: string): Promise<StoryThread[]> {
    const records = await query<StoryThreadRecord>(
      `SELECT * FROM ${TABLES.storyThread} WHERE project_id = '${esc(projectId)}' AND is_deleted = 0 ORDER BY name ASC`
    );
    return records.map((r) => recordToDomain(r));
  }

  async updateThread(input: UpdateStoryThreadInput): Promise<StoryThread> {
    const existing = await this.getThreadById(input.id);
    if (!existing) {
      throw new Error(`Thread ${input.id} not found`);
    }

    const now = new Date().toISOString();
    const lastModified = Date.now();

    const record: StoryThreadRecord = {
      id: existing.id,
      project_id: existing.projectId,
      name: input.name ?? existing.name,
      color: input.color ?? existing.color,
      summary: input.summary ?? existing.summary ?? null,
      pm_json: input.pmJson ? JSON.stringify(input.pmJson) : existing.pmJson ? JSON.stringify(existing.pmJson) : null,
      created_at: existing.createdAt.toISOString(),
      updated_at: now,
    };

    await updateThreadRecord(record, {
      syncStatus: 'pending',
      lastModified,
      isDeleted: 0,
    });

    if (canSync()) {
      syncManager.enqueue({
        type: 'update',
        entity: 'thread',
        localId: input.id,
        projectId: existing.projectId,
        data: {
          name: input.name,
          color: input.color,
          summary: input.summary,
          pmJson: input.pmJson,
        },
        priority: 'normal',
      });
    }

    const updated = await this.getThreadById(input.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated thread ${input.id}`);
    }
    return updated;
  }

  async deleteThread(id: string): Promise<void> {
    const existing = await this.getThreadById(id);
    const now = new Date().toISOString();
    const lastModified = Date.now();
    await run(
      `UPDATE ${TABLES.storyThread}
       SET is_deleted = 1,
           sync_status = 'pending',
           last_modified = ${lastModified},
           updated_at = '${esc(now)}'
       WHERE id = '${esc(id)}'`
    );

    if (existing && canSync()) {
      syncManager.enqueue({
        type: 'delete',
        entity: 'thread',
        localId: id,
        projectId: existing.projectId,
        priority: 'normal',
      });
    }
  }

  async addNodeToThread(nodeId: string, threadId: string): Promise<void> {
    // Get the current max order for this node
    const maxOrderResult = await query<{ max_order: number | null }>(
      `SELECT MAX(thread_order) as max_order FROM ${TABLES.nodeThread} WHERE node_id = '${esc(nodeId)}'`
    );
    const nextOrder = (maxOrderResult[0]?.max_order ?? -1) + 1;
    
    await run(
      `INSERT OR IGNORE INTO ${TABLES.nodeThread} (node_id, thread_id, thread_order) 
       VALUES ('${esc(nodeId)}', '${esc(threadId)}', ${nextOrder})`
    );
  }

  async removeNodeFromThread(nodeId: string, threadId: string): Promise<void> {
    await run(
      `DELETE FROM ${TABLES.nodeThread} WHERE node_id = '${esc(nodeId)}' AND thread_id = '${esc(threadId)}'`
    );
  }

  async getThreadsByNode(nodeId: string): Promise<StoryThread[]> {
    const records = await query<StoryThreadRecord>(
      `SELECT st.* FROM ${TABLES.storyThread} st
       INNER JOIN ${TABLES.nodeThread} nt ON nt.thread_id = st.id
       WHERE nt.node_id = '${esc(nodeId)}' AND st.is_deleted = 0
       ORDER BY nt.thread_order ASC`
    );
    return records.map((r) => recordToDomain(r));
  }

  async getNodeIdsByThread(threadId: string): Promise<string[]> {
    const records = await query<{ node_id: string }>(
      `SELECT node_id FROM ${TABLES.nodeThread} WHERE thread_id = '${esc(threadId)}'`
    );
    return records.map((r) => r.node_id);
  }

  async setNodeThreads(nodeId: string, threadIds: string[]): Promise<void> {
    // Remove all existing threads for this node
    await run(`DELETE FROM ${TABLES.nodeThread} WHERE node_id = '${esc(nodeId)}'`);

    // Add new threads with explicit order
    for (let i = 0; i < threadIds.length; i++) {
      await run(
        `INSERT INTO ${TABLES.nodeThread} (node_id, thread_id, thread_order)
         VALUES ('${esc(nodeId)}', '${esc(threadIds[i])}', ${i})`
      );
    }
  }
}

export interface RemoteThreadPayload {
  id: string;
  projectId: string;
  name: string;
  color?: string | null;
  summary?: string | null;
  pmJson?: object | null;
  createdAt: string;
  updatedAt: string;
  isDeleted?: boolean;
}

export async function markThreadSyncStatus(
  id: string,
  status: SyncStatus,
  options?: { updatedAt?: string; isDeleted?: boolean }
): Promise<void> {
  const record = await getThreadRecordById(id);
  if (!record) return;

  const updatedAtClause = options?.updatedAt ? `, updated_at='${esc(options.updatedAt)}'` : '';
  const parsed = options?.updatedAt ? Date.parse(options.updatedAt) : undefined;
  const lastModifiedClause = parsed && !Number.isNaN(parsed) ? `, last_modified=${parsed}` : '';
  const isDeletedClause = options?.isDeleted !== undefined ? `, is_deleted=${options.isDeleted ? 1 : 0}` : '';

  await run(
    `UPDATE ${TABLES.storyThread} SET sync_status='${status}'${updatedAtClause}${lastModifiedClause}${isDeletedClause} WHERE id='${esc(
      id,
    )}'`
  );

  if (status === 'synced' && ((options?.isDeleted && options.isDeleted) || record.is_deleted === 1)) {
    await run(`DELETE FROM ${TABLES.storyThread} WHERE id='${esc(id)}'`);
  }
}

export async function cleanupSyncedDeletedThreads(): Promise<void> {
  await run(`DELETE FROM ${TABLES.storyThread} WHERE is_deleted = 1 AND sync_status = 'synced'`);
}

export async function applyRemoteThread(thread: RemoteThreadPayload): Promise<'inserted' | 'updated' | 'skipped' | 'conflict'> {
  const remoteUpdatedAt = Date.parse(thread.updatedAt);
  if (Number.isNaN(remoteUpdatedAt)) {
    return 'skipped';
  }

  const existing = await getThreadRecordById(thread.id);
  const metadata: Partial<SyncMetadata> = {
    syncStatus: 'synced',
    lastModified: remoteUpdatedAt,
    isDeleted: thread.isDeleted ? 1 : 0,
  };

  if (thread.isDeleted) {
    if (!existing) {
      return 'skipped';
    }

    if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
      return 'conflict';
    }

    await run(
      `UPDATE ${TABLES.storyThread}
       SET is_deleted = 1,
           sync_status = 'synced',
           last_modified = ${remoteUpdatedAt},
           updated_at = '${esc(thread.updatedAt)}'
       WHERE id='${esc(thread.id)}'`
    );
    await cleanupSyncedDeletedThreads();
    return 'updated';
  }

  const baseRecord: StoryThreadRecord = {
    id: thread.id,
    project_id: thread.projectId,
    name: thread.name,
    color: thread.color ?? '#8b7355',
    summary: thread.summary ?? null,
    pm_json: thread.pmJson ? JSON.stringify(thread.pmJson) : null,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
  };

  if (!existing) {
    await insertThreadRecord(baseRecord, metadata);
    return 'inserted';
  }

  if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
    return 'conflict';
  }

  await updateThreadRecord(baseRecord, metadata);
  return existing.is_deleted === 1 ? 'inserted' : 'updated';
}

