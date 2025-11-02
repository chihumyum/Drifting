// Domain to Schema for BookNode

import { query, run } from '../lib/db';
import type { BookNode, BookNodeEdge, BookNodeTag, BookNodeElementLink } from '../domain/book_node';
import type { NodeType, BookNodeRecord, NodeEdgeRecord, ElementNodeLinkRecord, NodeTagRecord } from '../schema/book_node';
import type {
  BookNodeRepository,
  BookNodeEdgeRepository,
  BookNodeCreateData,
  BookNodeUpdateData,
  BookNodeEdgeCreateData,
} from './book_node';
import { DEFAULT_BOOK_NODE_STATUS } from './book_node';

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
    `INSERT INTO story_node (id, project_id, parent_id, type, title, order_key, status, summary, pos_x, pos_y, created_at, updated_at)
     VALUES (
       '${esc(record.id)}',
       '${esc(record.project_id)}',
       ${record.parent_id ? `'${esc(record.parent_id)}'` : 'NULL'},
       '${esc(record.type)}',
       '${esc(record.title)}',
       ${record.order_key},
       '${esc(record.status)}',
       ${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
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
       parent_id=${record.parent_id ? `'${esc(record.parent_id)}'` : 'NULL'},
       type='${esc(record.type)}',
       title='${esc(record.title)}',
       order_key=${record.order_key},
       status='${esc(record.status)}',
       summary=${record.summary ? `'${esc(record.summary)}'` : 'NULL'},
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
        `SELECT * FROM story_node WHERE project_id='${esc(targetProject)}' ORDER BY order_key ASC`,
      );
      return rows.map(toBookNode);
    },

    async findAllByType(type: NodeType, projectId?: string) {
      const targetProject = ensureProjectId(projectId, defaultProjectId);
      const rows = await query<BookNodeRecord>(
        `SELECT * FROM story_node WHERE project_id='${esc(targetProject)}' AND type='${esc(type)}' ORDER BY order_key ASC`,
      );
      return rows.map(toBookNode);
    },

    async create(data: BookNodeCreateData) {
      const nowIso = new Date().toISOString();
      const baseNode: BookNode = {
        id: data.id ?? crypto.randomUUID(),
        projectId: ensureProjectId(data.projectId, defaultProjectId),
        parentId: data.parentId ?? null,
        title: data.title ?? 'Untitled',
        type: data.type ?? 'chapter',
        orderKey: data.orderKey ?? Date.now(),
        status: data.status ?? DEFAULT_BOOK_NODE_STATUS,
        summary: data.summary ?? null,
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
        parentId: updates.parentId !== undefined ? updates.parentId : existingNode.parentId,
        title: updates.title ?? existingNode.title,
        type: updates.type ?? existingNode.type,
        orderKey: updates.orderKey ?? existingNode.orderKey,
        status: updates.status ?? existingNode.status,
        summary: updates.summary !== undefined ? updates.summary : existingNode.summary,
        position: mergePosition(existingNode.position, updates.position),
        createdAt: updates.createdAt ?? existingNode.createdAt,
        updatedAt: updates.updatedAt ?? new Date().toISOString(),
      };

      const record = fromBookNode(nextNode);
      await updateNodeRecord(record);
      return nextNode;
    },

    async delete(id: string) {
      await run(`DELETE FROM story_node WHERE id='${esc(id)}'`);
      return true;
    },

    async swapOrder(first, second) {
      const nowIso = new Date().toISOString();
      await run(
        `UPDATE story_node SET order_key=${second.orderKey}, updated_at='${esc(nowIso)}' WHERE id='${esc(first.id)}'`,
      );
      await run(
        `UPDATE story_node SET order_key=${first.orderKey}, updated_at='${esc(nowIso)}' WHERE id='${esc(second.id)}'`,
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

export function toBookNode(record: BookNodeRecord): BookNode {
  return {
    id: record.id,
    projectId: record.project_id,
    parentId: record.parent_id ?? null,
    title: record.title,
    type: record.type,
    orderKey: record.order_key,
    status: record.status,
    summary: record.summary ?? null,
    position: {
      x: record.pos_x ?? null,
      y: record.pos_y ?? null,
    },
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function fromBookNode(node: BookNode): BookNodeRecord {
  return {
    id: node.id,
    project_id: node.projectId,
    parent_id: node.parentId ?? null,
    title: node.title,
    type: node.type,
    order_key: node.orderKey,
    status: node.status,
    summary: node.summary ?? null,
    pos_x: node.position.x ?? null,
    pos_y: node.position.y ?? null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

export function toBookNodeEdge(record: NodeEdgeRecord): BookNodeEdge {
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

export function toBookNodeTag(record: NodeTagRecord): BookNodeTag {
  return {
    id: record.id,
    nodeId: record.node_id,
    name: record.name,
  };
}

export function toBookNodeElementLink(record: ElementNodeLinkRecord): BookNodeElementLink {
  return {
    id: record.id,
    nodeId: record.node_id,
    elementId: record.element_id,
  };
}
