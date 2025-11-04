import { query, run } from '../lib/db';
import type { BookNode, BookNodeEdge, BookNodeElementLink } from '../domain/book_node';
import type { BookNodeRecord, NodeEdgeRecord, ElementNodeLinkRecord } from '../schema/book_node';
import type {
  BookNodeRepository,
  BookNodeEdgeRepository,
  BookNodeCreateData,
  BookNodeUpdateData,
  BookNodeEdgeCreateData,
} from './book_node';

const esc = (v: string) => v.replaceAll("'", "''");

const ensureProjectId = (candidate: string | undefined, fallback: string) => candidate ?? fallback;

const mergePosition = (
  base: BookNode['position'],
  incoming: BookNodeCreateData['position'] | BookNodeUpdateData['position'],
): BookNode['position'] => ({
  x: incoming?.x ?? base.x,
  y: incoming?.y ?? base.y,
});

const insertNodeRecord = async (record: BookNodeRecord) => {
  await run(
    `INSERT INTO story_node (id, project_id, title, start, end, summary, story_stage_id, pos_x, pos_y, created_at, updated_at)
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
       '${esc(record.updated_at)}'
     )`,
  );
};

const updateNodeRecord = async (record: BookNodeRecord) => {
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
       updated_at='${esc(record.updated_at)}'
     WHERE id='${esc(record.id)}'`,
  );
};

const insertEdgeRecord = async (record: NodeEdgeRecord) => {
  await run(
    `INSERT INTO node_edge (id, project_id, src_node_id, dst_node_id, kind, label, weight, created_at, updated_at)
     VALUES (
       '${esc(record.id)}',
       '${esc(record.project_id)}',
       '${esc(record.src_node_id)}',
       '${esc(record.dst_node_id)}',
       '${esc(record.kind)}',
       ${record.label ? `'${esc(record.label)}'` : 'NULL'},
       ${record.weight},
       '${esc(record.created_at)}',
       '${esc(record.updated_at)}'
     )`,
  );
};

export function createBookNodeSqliteRepository(defaultProjectId: string): BookNodeRepository {
  return {
    async findById(id: string) {
      const rows = await query<BookNodeRecord>(`SELECT * FROM story_node WHERE id='${esc(id)}' LIMIT 1`);
      const record = rows[0];
      return record ? toBookNode(record) : null;
    },

    async findAll(projectId?: string) {
      const targetProject = ensureProjectId(projectId, defaultProjectId);
      const rows = await query<BookNodeRecord>(
        `SELECT * FROM story_node WHERE project_id='${esc(targetProject)}' ORDER BY start ASC`,
      );
      return rows.map(toBookNode);
    },

    async create(data: BookNodeCreateData) {
      const nowIso = new Date().toISOString();
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
      await insertNodeRecord(record);
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
      await updateNodeRecord(record);
      return nextNode;
    },

    async delete(id: string) {
      console.log('[BookNodeRepository] Deleting node:', id);
      const changes = await run(`DELETE FROM story_node WHERE id='${esc(id)}'`);
      console.log('[BookNodeRepository] Delete result - changes:', changes);
      return true;
    },

    async swapOrder(first, second) {
      const nowIso = new Date().toISOString();
      await run(
        `UPDATE story_node SET start=${second.start}, updated_at='${esc(nowIso)}' WHERE id='${esc(first.id)}'`,
      );
      await run(
        `UPDATE story_node SET start=${first.start}, updated_at='${esc(nowIso)}' WHERE id='${esc(second.id)}'`,
      );
    },
  };
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
        created_at: data.createdAt ?? nowIso,
        updated_at: data.updatedAt ?? nowIso,
      };

      await insertEdgeRecord(record);
      return toBookNodeEdge(record);
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
  return {
    id: record.id,
    projectId: record.project_id,
    sourceNodeId: record.src_node_id,
    targetNodeId: record.dst_node_id,
    kind: record.kind,
    label: record.label ?? null,
    weight: record.weight,
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
