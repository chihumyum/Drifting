import { query, run } from '../lib/db';
import type { BookNode, BookNodeEdge, BookNodeElementLink } from '../domain/book_node';
import type { BookNodeRecord, NodeEdgeRecord, ElementNodeLinkRecord } from '../schema/book_node';
import type {
  BookNodeRepository,
  BookNodeEdgeRepository,
  BookNodeCreateData,
  BookNodeUpdateData,
  BookNodeEdgeCreateData,
  BookNodeEdgeUpdateData,
} from './book_node';

type SyncStatus = 'synced' | 'pending' | 'syncing' | 'failed';

interface SyncMetadata {
  syncStatus: SyncStatus;
  lastModified: number;
  isDeleted: number;
}

const esc = (v: string) => v.replaceAll("'", "''");

const ensureProjectId = (candidate: string | undefined, fallback: string) => candidate ?? fallback;

const mergePosition = (
  base: BookNode['position'],
  incoming: BookNodeCreateData['position'] | BookNodeUpdateData['position'],
): BookNode['position'] => ({
  x: incoming?.x ?? base.x,
  y: incoming?.y ?? base.y,
});

const ensureSyncMetadata = (metadata?: Partial<SyncMetadata>): SyncMetadata => ({
  syncStatus: metadata?.syncStatus ?? 'synced',
  lastModified: metadata?.lastModified ?? Date.now(),
  isDeleted: metadata?.isDeleted ?? 0,
});

const getNodeRecordById = async (id: string) => {
  const rows = await query<BookNodeRecord & {
    sync_status?: SyncStatus;
    last_modified?: number | null;
    is_deleted?: number;
  }>(`SELECT * FROM story_node WHERE id='${esc(id)}' LIMIT 1`);
  return rows[0];
};

const insertNodeRecord = async (record: BookNodeRecord, metadata?: Partial<SyncMetadata>) => {
  const sync = ensureSyncMetadata(metadata);
  await run(
    `INSERT INTO story_node (id, project_id, title, start, end, summary, story_stage_id, pos_x, pos_y, created_at, updated_at, sync_status, last_modified, is_deleted)
     VALUES (
       '${esc(record.id)}',
       '${esc(record.project_id)}',
       '${esc(record.title)}',
       ${record.start},
       ${record.end ?? 'NULL'},
       ${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
       ${record.story_stage_id ? `'${esc(record.story_stage_id)}'` : 'NULL'},
       ${record.pos_x ?? 'NULL'},
       ${record.pos_y ?? 'NULL'},
       '${esc(record.created_at)}',
       '${esc(record.updated_at)}',
       '${sync.syncStatus}',
       ${sync.lastModified},
       ${sync.isDeleted}
     )`,
  );
};

const updateNodeRecord = async (record: BookNodeRecord, metadata?: Partial<SyncMetadata>) => {
  const sync = ensureSyncMetadata(metadata);
  await run(
    `UPDATE story_node SET
       project_id='${esc(record.project_id)}',
       title='${esc(record.title)}',
       start=${record.start},
       end=${record.end ?? 'NULL'},
       summary=${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
       story_stage_id=${record.story_stage_id ? `'${esc(record.story_stage_id)}'` : 'NULL'},
       pos_x=${record.pos_x ?? 'NULL'},
       pos_y=${record.pos_y ?? 'NULL'},
       created_at='${esc(record.created_at)}',
       updated_at='${esc(record.updated_at)}',
       sync_status='${sync.syncStatus}',
       last_modified=${sync.lastModified},
       is_deleted=${sync.isDeleted}
     WHERE id='${esc(record.id)}'`,
  );
};

const insertEdgeRecord = async (record: NodeEdgeRecord) => {
  await run(
    `INSERT INTO node_edge (id, project_id, src_node_id, dst_node_id, kind, label, weight, style, data, created_at, updated_at)
     VALUES (
       '${esc(record.id)}',
       '${esc(record.project_id)}',
       '${esc(record.src_node_id)}',
       '${esc(record.dst_node_id)}',
       '${esc(record.kind)}',
       ${record.label ? `'${esc(record.label)}'` : 'NULL'},
       ${record.weight},
       ${record.style ? `'${esc(record.style)}'` : 'NULL'},
       ${record.data ? `'${esc(record.data)}'` : 'NULL'},
       '${esc(record.created_at)}',
       '${esc(record.updated_at)}'
     )`,
  );
};

const updateEdgeRecord = async (record: NodeEdgeRecord) => {
  await run(
    `UPDATE node_edge SET
       project_id='${esc(record.project_id)}',
       src_node_id='${esc(record.src_node_id)}',
       dst_node_id='${esc(record.dst_node_id)}',
       kind='${esc(record.kind)}',
       label=${record.label ? `'${esc(record.label)}'` : 'NULL'},
       weight=${record.weight},
       style=${record.style ? `'${esc(record.style)}'` : 'NULL'},
       data=${record.data ? `'${esc(record.data)}'` : 'NULL'},
       updated_at='${esc(record.updated_at)}'
     WHERE id='${esc(record.id)}'`
  );
};

export function createBookNodeSqliteRepository(defaultProjectId: string): BookNodeRepository {
  return {
    async findById(id: string) {
      const rows = await query<BookNodeRecord>(
        `SELECT * FROM story_node WHERE id='${esc(id)}' AND is_deleted = 0 LIMIT 1`
      );
      const record = rows[0];
      return record ? toBookNode(record) : null;
    },

    async findAll(projectId?: string) {
      const targetProject = ensureProjectId(projectId, defaultProjectId);
      const rows = await query<BookNodeRecord>(
        `SELECT * FROM story_node WHERE project_id='${esc(targetProject)}' AND is_deleted = 0 ORDER BY start ASC`,
      );
      return rows.map(toBookNode);
    },

    async create(data: BookNodeCreateData) {
      const nowIso = new Date().toISOString();
      const lastModified = Date.now();
      const baseNode: BookNode = {
        id: data.id ?? crypto.randomUUID(),
        projectId: ensureProjectId(data.projectId, defaultProjectId),
        title: data.title ?? 'Untitled',
        start: data.start ?? Date.now(),
        end: data.end ?? null,
        summary: data.summary ?? null,
        storyStageId: data.storyStageId ?? null,
        position: mergePosition({ x: null, y: null }, data.position),
        createdAt: data.createdAt ?? nowIso,
        updatedAt: data.updatedAt ?? nowIso,
      };

      const record = fromBookNode(baseNode);
      await insertNodeRecord(record, {
        syncStatus: 'pending',
        lastModified,
        isDeleted: 0,
      });
      return baseNode;
    },

    async update(id: string, updates: BookNodeUpdateData) {
      const rows = await query<BookNodeRecord>(`SELECT * FROM story_node WHERE id='${esc(id)}' LIMIT 1`);
      const existingRecord = rows[0];
      if (!existingRecord) return null;

      const existingNode = toBookNode(existingRecord);
      const nextNode: BookNode = {
        id: existingNode.id,
        projectId: updates.projectId ?? existingNode.projectId,
        title: updates.title ?? existingNode.title,
        start: updates.start ?? existingNode.start,
        end: updates.end !== undefined ? updates.end : existingNode.end,
        summary: updates.summary !== undefined ? updates.summary : existingNode.summary,
        storyStageId: updates.storyStageId !== undefined ? updates.storyStageId : existingNode.storyStageId,
        position: mergePosition(existingNode.position, updates.position),
        createdAt: updates.createdAt ?? existingNode.createdAt,
        updatedAt: updates.updatedAt ?? new Date().toISOString(),
      };

      const record = fromBookNode(nextNode);
      await updateNodeRecord(record, {
        syncStatus: 'pending',
        lastModified: Date.now(),
        isDeleted: 0,
      });
      return nextNode;
    },

    async delete(id: string) {
      console.log('[BookNodeRepository] Soft deleting node:', id);
      const nowIso = new Date().toISOString();
      const lastModified = Date.now();
      await run(
        `UPDATE story_node SET is_deleted = 1, sync_status = 'pending', last_modified = ${lastModified}, updated_at='${esc(
          nowIso,
        )}' WHERE id='${esc(id)}'`
      );
      return true;
    },

    async swapOrder(first, second) {
      const nowIso = new Date().toISOString();
      const lastModified = Date.now();
      await run(
        `UPDATE story_node SET start=${second.start}, updated_at='${esc(nowIso)}', sync_status='pending', last_modified=${lastModified} WHERE id='${esc(first.id)}'`,
      );
      await run(
        `UPDATE story_node SET start=${first.start}, updated_at='${esc(nowIso)}', sync_status='pending', last_modified=${lastModified} WHERE id='${esc(second.id)}'`,
      );
    },
  };
}

export async function markNodeSyncStatus(
  id: string,
  status: SyncStatus,
  options?: { updatedAt?: string }
): Promise<void> {
  const record = await getNodeRecordById(id);
  if (!record) return;

  const updatedAtClause = options?.updatedAt ? `, updated_at='${esc(options.updatedAt)}'` : '';
  const parsedLastModified = options?.updatedAt ? Date.parse(options.updatedAt) : undefined;
  const lastModifiedClause = parsedLastModified && !Number.isNaN(parsedLastModified)
    ? `, last_modified=${parsedLastModified}`
    : '';
  await run(
    `UPDATE story_node SET sync_status='${status}'${updatedAtClause}${lastModifiedClause} WHERE id='${esc(id)}'`
  );

  if (status === 'synced' && record.is_deleted === 1) {
    await run(`DELETE FROM story_node WHERE id='${esc(id)}'`);
  }
}

export async function applyRemoteNode(node: BookNode): Promise<'inserted' | 'updated' | 'skipped' | 'conflict'> {
  const remoteUpdatedAt = Date.parse(node.updatedAt);
  if (Number.isNaN(remoteUpdatedAt)) {
    return 'skipped';
  }

  const existing = await getNodeRecordById(node.id);
  const record = fromBookNode(node);
  if (!existing) {
    await insertNodeRecord(record, { syncStatus: 'synced', lastModified: remoteUpdatedAt, isDeleted: 0 });
    return 'inserted';
  }

  const localStatus = (existing.sync_status ?? 'synced') as SyncStatus;
  const localLastModified = existing.last_modified ?? 0;

  if (localStatus === 'pending' && localLastModified > remoteUpdatedAt) {
    return 'conflict';
  }

  await updateNodeRecord(record, { syncStatus: 'synced', lastModified: remoteUpdatedAt, isDeleted: 0 });
  return 'updated';
}

export async function cleanupSyncedDeletedNodes(): Promise<void> {
  await run(`DELETE FROM story_node WHERE is_deleted = 1 AND sync_status = 'synced'`);
}

export function createBookNodeEdgeSqliteRepository(defaultProjectId: string): BookNodeEdgeRepository {
  return {
    async findAll(projectId?: string) {
      const targetProject = ensureProjectId(projectId, defaultProjectId);
      const rows = await query<NodeEdgeRecord>(
        `SELECT * FROM node_edge WHERE project_id='${esc(targetProject)}' ORDER BY created_at ASC`,
      );
      return rows.map(toBookNodeEdge);
    },

    async create(data: BookNodeEdgeCreateData) {
      const nowIso = new Date().toISOString();
      const record: NodeEdgeRecord = {
        id: data.id ?? crypto.randomUUID(),
        project_id: ensureProjectId(data.projectId, defaultProjectId),
        src_node_id: data.sourceNodeId,
        dst_node_id: data.targetNodeId,
        kind: data.kind ?? 'chronology',
        label: data.label ?? null,
        weight: data.weight ?? 1,
        style: data.style ? JSON.stringify(data.style) : undefined,
        data: (data.controlPointOffset || data.sourceAnchor || data.targetAnchor) ? JSON.stringify({
          controlPointOffset: data.controlPointOffset,
          sourceAnchor: data.sourceAnchor,
          targetAnchor: data.targetAnchor
        }) : undefined,
        created_at: data.createdAt ?? nowIso,
        updated_at: data.updatedAt ?? nowIso,
      };

      await insertEdgeRecord(record);
      return toBookNodeEdge(record);
    },

    async update(id: string, updates: BookNodeEdgeUpdateData) {
      const rows = await query<NodeEdgeRecord>(`SELECT * FROM node_edge WHERE id='${esc(id)}' LIMIT 1`);
      const existingRecord = rows[0];
      if (!existingRecord) return null;

      const existingEdge = toBookNodeEdge(existingRecord);

      const geometricData = (updates.controlPointOffset || updates.sourceAnchor || updates.targetAnchor) ? {
        controlPointOffset: updates.controlPointOffset ?? existingEdge.controlPointOffset,
        sourceAnchor: updates.sourceAnchor ?? existingEdge.sourceAnchor,
        targetAnchor: updates.targetAnchor ?? existingEdge.targetAnchor
      } : (existingRecord.data ? JSON.parse(existingRecord.data) : {});

      // If style is updated, merge or replace? Let's replace for now based on input interface usually taking full object or partial merge.
      // But here input style is BookNodeEdge['style'] which is the whole object.
      // If we want merge, we need to do it here. Let's assume input provides the new state for that field if present.

      const nextEdge: BookNodeEdge = {
        id: existingEdge.id,
        projectId: updates.projectId ?? existingEdge.projectId,
        sourceNodeId: updates.sourceNodeId ?? existingEdge.sourceNodeId,
        targetNodeId: updates.targetNodeId ?? existingEdge.targetNodeId,
        kind: updates.kind ?? existingEdge.kind,
        label: updates.label !== undefined ? updates.label : existingEdge.label,
        weight: updates.weight ?? existingEdge.weight,
        style: updates.style ?? existingEdge.style,
        controlPointOffset: geometricData.controlPointOffset,
        sourceAnchor: geometricData.sourceAnchor,
        targetAnchor: geometricData.targetAnchor,
        createdAt: existingEdge.createdAt,
        // updatedAt: updates.updatedAt ?? new Date().toISOString()
      };

      const nowIso = new Date().toISOString();
      const record: NodeEdgeRecord = {
        id: nextEdge.id,
        project_id: nextEdge.projectId,
        src_node_id: nextEdge.sourceNodeId,
        dst_node_id: nextEdge.targetNodeId,
        kind: nextEdge.kind,
        label: nextEdge.label,
        weight: nextEdge.weight,
        style: nextEdge.style ? JSON.stringify(nextEdge.style) : undefined,
        data: JSON.stringify({
          controlPointOffset: nextEdge.controlPointOffset,
          sourceAnchor: nextEdge.sourceAnchor,
          targetAnchor: nextEdge.targetAnchor
        }),
        created_at: nextEdge.createdAt,
        updated_at: updates.updatedAt ?? nowIso
      };

      await updateEdgeRecord(record);
      return nextEdge;
    },

    async delete(id: string) {
      await run(`DELETE FROM node_edge WHERE id='${esc(id)}'`);
      return true;
    },
  };
}

function toBookNode(record: BookNodeRecord): BookNode {
  return {
    id: record.id,
    projectId: record.project_id,
    title: record.title,
    start: record.start,
    end: record.end ?? null,
    summary: record.summary ?? null,
    storyStageId: record.story_stage_id ?? null,
    position: {
      x: record.pos_x ?? null,
      y: record.pos_y ?? null,
    },
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function fromBookNode(node: BookNode): BookNodeRecord {
  return {
    id: node.id,
    project_id: node.projectId,
    title: node.title,
    start: node.start,
    end: node.end ?? null,
    summary: node.summary ?? null,
    story_stage_id: node.storyStageId ?? undefined,
    pos_x: node.position.x ?? null,
    pos_y: node.position.y ?? null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

function toBookNodeEdge(record: NodeEdgeRecord): BookNodeEdge {
  const geometricData = record.data ? JSON.parse(record.data) : {};
  return {
    id: record.id,
    projectId: record.project_id,
    sourceNodeId: record.src_node_id,
    targetNodeId: record.dst_node_id,
    kind: record.kind,
    label: record.label ?? null,
    weight: record.weight,
    style: record.style ? JSON.parse(record.style) : undefined,
    controlPointOffset: geometricData.controlPointOffset,
    sourceAnchor: geometricData.sourceAnchor,
    targetAnchor: geometricData.targetAnchor,
    createdAt: record.created_at,
  };
}

export function toBookNodeElementLink(record: ElementNodeLinkRecord): BookNodeElementLink {
  return {
    id: record.id,
    nodeId: record.node_id,
    elementId: record.element_id,
  };
}
