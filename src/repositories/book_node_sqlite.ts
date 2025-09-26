import { query, run } from '../lib/db';
import type { BookNodeRecord, NodeEdge, NodeType } from '../schema/book_node';
import type { BookNodeRepository, BookNodeEdgeRepository } from './book_node';

const esc = (v: string) => v.replaceAll("'", "''");

export function createBookNodeSqliteRepository(projectId: string): BookNodeRepository {
  return {
    async findById(id: string) {
      const rows = await query<BookNodeRecord>(`SELECT * FROM story_node WHERE id='${esc(id)}' LIMIT 1`);
      return rows[0] ?? null;
    },
    async findAll(pid?: string) {
      const targetProject = pid ?? projectId;
      return query<BookNodeRecord>(`SELECT * FROM story_node WHERE project_id='${esc(targetProject)}' ORDER BY order_key ASC`);
    },
    async findAllByType(type: NodeType, pid?: string) {
      const targetProject = pid ?? projectId;
      return query<BookNodeRecord>(
        `SELECT * FROM story_node WHERE project_id='${esc(targetProject)}' AND type='${esc(type)}' ORDER BY order_key ASC`
      );
    },
    async create(data: Partial<BookNodeRecord>) {
      const id = data.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const rec: BookNodeRecord = {
        id,
        project_id: data.project_id ?? projectId,
        parent_id: data.parent_id ?? null,
        title: data.title ?? 'Untitled',
        type: data.type ?? 'chapter',
        order_key: data.order_key ?? Date.now(),
        status: data.status ?? 'draft',
        summary: data.summary ?? null,
        pos_x: data.pos_x ?? null,
        pos_y: data.pos_y ?? null,
        created_at: data.created_at ?? now,
        updated_at: data.updated_at ?? now,
      };
      await run(`INSERT INTO story_node (id, project_id, parent_id, type, title, order_key, status, summary, pos_x, pos_y, created_at, updated_at)
        VALUES ('${esc(rec.id)}','${esc(rec.project_id)}',${rec.parent_id ? `'${esc(rec.parent_id)}'` : 'NULL'},'${esc(rec.type)}','${esc(rec.title)}',${rec.order_key},'${esc(rec.status)}',${rec.summary ? `'${esc(rec.summary)}'` : 'NULL'},${rec.pos_x ?? 'NULL'},${rec.pos_y ?? 'NULL'},'${esc(rec.created_at)}','${esc(rec.updated_at)}')`);
      return rec;
    },
    async update(id: string, data: Partial<BookNodeRecord>) {
      const existing = await this.findById(id);
      if (!existing) return null;
      const updated: BookNodeRecord = {
        ...existing,
        ...data,
        updated_at: new Date().toISOString(),
      };
      await run(`UPDATE story_node SET
        project_id='${esc(updated.project_id)}',
        parent_id=${updated.parent_id ? `'${esc(updated.parent_id)}'` : 'NULL'},
        type='${esc(updated.type)}',
        title='${esc(updated.title)}',
        order_key=${updated.order_key},
        status='${esc(updated.status)}',
        summary=${updated.summary ? `'${esc(updated.summary)}'` : 'NULL'},
        pos_x=${updated.pos_x ?? 'NULL'},
        pos_y=${updated.pos_y ?? 'NULL'},
        created_at='${esc(updated.created_at)}',
        updated_at='${esc(updated.updated_at)}'
        WHERE id='${esc(id)}'`);
      return updated;
    },
    async delete(id: string) {
      await run(`DELETE FROM story_node WHERE id='${esc(id)}'`);
      return true;
    },
    async swapOrder(first, second) {
      const now = new Date().toISOString();
      await run(`UPDATE story_node SET order_key=${second.orderKey}, updated_at='${esc(now)}' WHERE id='${esc(first.id)}'`);
      await run(`UPDATE story_node SET order_key=${first.orderKey}, updated_at='${esc(now)}' WHERE id='${esc(second.id)}'`);
    },
  };
}

export function createBookNodeEdgeSqliteRepository(projectId: string): BookNodeEdgeRepository {
  return {
    async findAll(pid?: string) {
      const targetProject = pid ?? projectId;
      return query<NodeEdge>(`SELECT * FROM node_edge WHERE project_id='${esc(targetProject)}' ORDER BY created_at ASC`);
    },
    async create(data: Partial<NodeEdge>) {
      const id = data.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const rec: NodeEdge = {
        id,
        project_id: data.project_id ?? projectId,
        src_node_id: data.src_node_id ?? '',
        dst_node_id: data.dst_node_id ?? '',
        kind: data.kind ?? 'chronology',
        label: data.label ?? null,
        weight: data.weight ?? 1,
        created_at: data.created_at ?? now,
      };
      await run(`INSERT INTO node_edge (id, project_id, src_node_id, dst_node_id, kind, label, weight, created_at)
        VALUES ('${esc(rec.id)}','${esc(rec.project_id)}','${esc(rec.src_node_id)}','${esc(rec.dst_node_id)}','${esc(rec.kind)}',${rec.label ? `'${esc(rec.label)}'` : 'NULL'},${rec.weight},'${esc(rec.created_at)}')`);
      return rec;
    },
    async delete(id: string) {
      await run(`DELETE FROM node_edge WHERE id='${esc(id)}'`);
      return true;
    },
  };
}
