// operations related to book contents (prosemirror json based for now, yjs later)
import type { BookContent } from '../domain/book_content';
import type { BookContentRecord } from '../schema/book_content';
import type { BookContentRepository } from './book_content';
import { v7 as uuidv7 } from 'uuid';
import { run, query } from '../lib/db';


export function recordToBookContent(record: BookContentRecord): BookContent {
  return {
    id: record.id,
    nodeId: record.node_id,
    pmJson: record.pm_json,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function bookContentToRecord(node: BookContent): BookContentRecord {
  return {
    id: node.id,
    node_id: node.nodeId,
    pm_json: node.pmJson,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

export function createBookContentRepository(): BookContentRepository {
    const selectBase = `SELECT bc.* FROM book_content bc`;

    const findById = async (id: string): Promise<BookContent | null> => {
      const result = await query<BookContentRecord>(`${selectBase} WHERE bc.id = ?`, [id]);
      return result.length ? recordToBookContent(result[0]) : null;
    };

    const findByNodeId = async (nodeId: string): Promise<BookContent | null> => {
        console.log("Incoming nodeId:", nodeId);
        const result = await query<BookContentRecord>(`${selectBase} WHERE bc.node_id = ?`, [nodeId]);
        console.log("Query result:", result);
        return result.length ? recordToBookContent(result[0]) : null;
    };

    const create = async (data: Partial<BookContent>): Promise<BookContent> => {
      const now = new Date().toISOString();
      const record: BookContentRecord = {
        id: data.id || uuidv7(),
        node_id: data.nodeId!,
        pm_json: data.pmJson || '',
        created_at: now,
        updated_at: now,
      };
      await run(
        `INSERT INTO book_content (id, node_id, pm_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [record.id, record.node_id, record.pm_json, record.created_at, record.updated_at]
      );
      return recordToBookContent(record);
    }

    const update = async (id: string, data: Partial<BookContent>): Promise<BookContent | null> => {
      const now = new Date().toISOString();
      const createdAt = await findById(id).then(existing => existing ? existing.createdAt : now);
      const record: BookContentRecord = {
        id,
        node_id: data.nodeId!,
        pm_json: data.pmJson || '',
        created_at: createdAt,
        updated_at: now,
      };
      await run(
        `UPDATE book_content SET node_id = ?, pm_json = ?, updated_at = ? WHERE id = ?`,
        [record.node_id, record.pm_json, record.updated_at, record.id]
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