import { query, run } from '../lib/db';
import type { StorylineRepository } from './storyline';
import type { Storyline, CreateStorylineInput, UpdateStorylineInput } from '../domain/storyline';
import type { StorylineRecord } from '../schema/storyline';
import { TABLES } from '../schema/table';
import { syncManager } from '../lib/sync/sync-manager';
import { useAuthStore } from '../store/auth';
import loglevel from "loglevel";

const log = loglevel.getLogger("StorylineSqliteRepository");
log.setLevel(loglevel.levels.ERROR);

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
    log.warn('[StorylineRepository] Failed to parse pm_json:', error);
    return undefined;
  }
};

const recordToDomain = (record: StorylineRecord): Storyline => ({
  id: record.id,
  projectId: record.project_id,
  name: record.name,
  color: record.color,
  summary: record.summary || undefined,
  pmJson: parsePmJson(record.pm_json),
  createdAt: new Date(record.created_at),
  updatedAt: new Date(record.updated_at),
});

const ensureStorylineRecord = (record: StorylineRecord): StorylineRecord & Required<Pick<StorylineRecord, 'sync_status' | 'last_modified' | 'is_deleted'>> => ({
  ...record,
  sync_status: record.sync_status ?? 'synced',
  last_modified: record.last_modified ?? (Date.parse(record.updated_at) || Date.now()),
  is_deleted: record.is_deleted ?? 0,
});

const getStorylineRecordById = async (id: string) => {
  const rows = await query<StorylineRecord & { sync_status?: SyncStatus; last_modified?: number | null; is_deleted?: number }>(
    `SELECT * FROM ${TABLES.storyline} WHERE id='${esc(id)}' LIMIT 1`
  );
  return rows[0] ? ensureStorylineRecord(rows[0]) : undefined;
};

const insertStorylineRecord = async (record: StorylineRecord, metadata?: Partial<SyncMetadata>) => {
  const sync = ensureSyncMetadata(metadata);
  await run(
    `INSERT INTO ${TABLES.storyline}
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

const updateStorylineRecord = async (record: StorylineRecord, metadata?: Partial<SyncMetadata>) => {
  const sync = ensureSyncMetadata(metadata);
  await run(
    `UPDATE ${TABLES.storyline} SET
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

export class StorylineSQLiteRepository implements StorylineRepository {
  async createStoryline(input: CreateStorylineInput): Promise<Storyline> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const lastModified = Date.now();

    const record: StorylineRecord = {
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

    await insertStorylineRecord(record, {
      syncStatus: 'pending',
      lastModified,
      isDeleted: 0,
    });

    if (canSync()) {
      syncManager.enqueue({
        type: 'create',
        entity: 'storyline',
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

  async getStorylineById(id: string): Promise<Storyline | null> {
    const records = await query<StorylineRecord>(
      `SELECT * FROM ${TABLES.storyline} WHERE id = '${esc(id)}' AND is_deleted = 0`
    );
    return records.length > 0 ? recordToDomain(records[0]) : null;
  }

  async getStorylinesByProject(projectId: string): Promise<Storyline[]> {
    const records = await query<StorylineRecord>(
      `SELECT * FROM ${TABLES.storyline} WHERE project_id = '${esc(projectId)}' AND is_deleted = 0 ORDER BY name ASC`
    );
    return records.map((r) => recordToDomain(r));
  }

  async updateStoryline(input: UpdateStorylineInput): Promise<Storyline> {
    const existing = await this.getStorylineById(input.id);
    if (!existing) {
      throw new Error(`Storyline ${input.id} not found`);
    }

    const now = new Date().toISOString();
    const lastModified = Date.now();

    const record: StorylineRecord = {
      id: existing.id,
      project_id: existing.projectId,
      name: input.name ?? existing.name,
      color: input.color ?? existing.color,
      summary: input.summary ?? existing.summary ?? null,
      pm_json: input.pmJson ? JSON.stringify(input.pmJson) : existing.pmJson ? JSON.stringify(existing.pmJson) : null,
      created_at: existing.createdAt.toISOString(),
      updated_at: now,
    };

    await updateStorylineRecord(record, {
      syncStatus: 'pending',
      lastModified,
      isDeleted: 0,
    });

    if (canSync()) {
      syncManager.enqueue({
        type: 'update',
        entity: 'storyline',
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

    const updated = await this.getStorylineById(input.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated storyline ${input.id}`);
    }
    return updated;
  }

  async deleteStoryline(id: string): Promise<void> {
    const existing = await this.getStorylineById(id);
    const now = new Date().toISOString();
    const lastModified = Date.now();
    await run(
      `UPDATE ${TABLES.storyline}
       SET is_deleted = 1,
           sync_status = 'pending',
           last_modified = ${lastModified},
           updated_at = '${esc(now)}'
       WHERE id = '${esc(id)}'`
    );

    if (existing && canSync()) {
      syncManager.enqueue({
        type: 'delete',
        entity: 'storyline',
        localId: id,
        projectId: existing.projectId,
        priority: 'normal',
      });
    }
  }

  async addNodeToStoryline(nodeId: string, storylineId: string): Promise<void> {
    // Get the current max order for this node
    const maxOrderResult = await query<{ max_order: number | null }>(
      `SELECT MAX(storyline_order) as max_order FROM ${TABLES.nodeStoryline} WHERE node_id = '${esc(nodeId)}'`
    );
    const nextOrder = (maxOrderResult[0]?.max_order ?? -1) + 1;
    
    await run(
      `INSERT OR IGNORE INTO ${TABLES.nodeStoryline} (node_id, storyline_id, storyline_order) 
       VALUES ('${esc(nodeId)}', '${esc(storylineId)}', ${nextOrder})`
    );
  }

  async removeNodeFromStoryline(nodeId: string, storylineId: string): Promise<void> {
    await run(
      `DELETE FROM ${TABLES.nodeStoryline} WHERE node_id = '${esc(nodeId)}' AND storyline_id = '${esc(storylineId)}'`
    );
  }

  async getStorylinesByNode(nodeId: string): Promise<Storyline[]> {
    const records = await query<StorylineRecord>(
      `SELECT st.* FROM ${TABLES.storyline} st
       INNER JOIN ${TABLES.nodeStoryline} nt ON nt.storyline_id = st.id
       WHERE nt.node_id = '${esc(nodeId)}' AND st.is_deleted = 0
       ORDER BY nt.storyline_order ASC`
    );
    return records.map((r) => recordToDomain(r));
  }

  async getNodeIdsByStoryline(storylineId: string): Promise<string[]> {
    const records = await query<{ node_id: string }>(
      `SELECT node_id FROM ${TABLES.nodeStoryline} WHERE storyline_id = '${esc(storylineId)}'`
    );
    return records.map((r) => r.node_id);
  }

  async setNodeStorylines(nodeId: string, storylineIds: string[]): Promise<void> {
    // Remove all existing storylines for this node
    await run(`DELETE FROM ${TABLES.nodeStoryline} WHERE node_id = '${esc(nodeId)}'`);

    // Add new storylines with explicit order
    for (let i = 0; i < storylineIds.length; i++) {
      await run(
        `INSERT INTO ${TABLES.nodeStoryline} (node_id, storyline_id, storyline_order)
         VALUES ('${esc(nodeId)}', '${esc(storylineIds[i])}', ${i})`
      );
    }
  }
}

export interface RemoteStorylinePayload {
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

export async function markStorylineSyncStatus(
  id: string,
  status: SyncStatus,
  options?: { updatedAt?: string; isDeleted?: boolean }
): Promise<void> {
  const record = await getStorylineRecordById(id);
  if (!record) return;

  const updatedAtClause = options?.updatedAt ? `, updated_at='${esc(options.updatedAt)}'` : '';
  const parsed = options?.updatedAt ? Date.parse(options.updatedAt) : undefined;
  const lastModifiedClause = parsed && !Number.isNaN(parsed) ? `, last_modified=${parsed}` : '';
  const isDeletedClause = options?.isDeleted !== undefined ? `, is_deleted=${options.isDeleted ? 1 : 0}` : '';

  await run(
    `UPDATE ${TABLES.storyline} SET sync_status='${status}'${updatedAtClause}${lastModifiedClause}${isDeletedClause} WHERE id='${esc(
      id,
    )}'`
  );

  if (status === 'synced' && ((options?.isDeleted && options.isDeleted) || record.is_deleted === 1)) {
    await run(`DELETE FROM ${TABLES.storyline} WHERE id='${esc(id)}'`);
  }
}

export async function cleanupSyncedDeletedStorylines(): Promise<void> {
  await run(`DELETE FROM ${TABLES.storyline} WHERE is_deleted = 1 AND sync_status = 'synced'`);
}

export async function applyRemoteStoryline(storyline: RemoteStorylinePayload): Promise<'inserted' | 'updated' | 'skipped' | 'conflict'> {
  const remoteUpdatedAt = Date.parse(storyline.updatedAt);
  if (Number.isNaN(remoteUpdatedAt)) {
    return 'skipped';
  }

  const existing = await getStorylineRecordById(storyline.id);
  const metadata: Partial<SyncMetadata> = {
    syncStatus: 'synced',
    lastModified: remoteUpdatedAt,
    isDeleted: storyline.isDeleted ? 1 : 0,
  };

  if (storyline.isDeleted) {
    if (!existing) {
      return 'skipped';
    }

    if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
      return 'conflict';
    }

    await run(
      `UPDATE ${TABLES.storyline}
       SET is_deleted = 1,
           sync_status = 'synced',
           last_modified = ${remoteUpdatedAt},
           updated_at = '${esc(storyline.updatedAt)}'
       WHERE id='${esc(storyline.id)}'`
    );
    await cleanupSyncedDeletedStorylines();
    return 'updated';
  }

  const baseRecord: StorylineRecord = {
    id: storyline.id,
    project_id: storyline.projectId,
    name: storyline.name,
    color: storyline.color ?? '#8b7355',
    summary: storyline.summary ?? null,
    pm_json: storyline.pmJson ? JSON.stringify(storyline.pmJson) : null,
    created_at: storyline.createdAt,
    updated_at: storyline.updatedAt,
  };

  if (!existing) {
    await insertStorylineRecord(baseRecord, metadata);
    return 'inserted';
  }

  if (existing.sync_status === 'pending' && (existing.last_modified ?? 0) > remoteUpdatedAt) {
    return 'conflict';
  }

  await updateStorylineRecord(baseRecord, metadata);
  return existing.is_deleted === 1 ? 'inserted' : 'updated';
}

