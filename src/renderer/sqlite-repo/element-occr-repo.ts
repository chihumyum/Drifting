import { v7 as uuidv7 } from 'uuid';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { BookNodeTable, ElementOccurrenceTable } from '../schema/drizzle';

export interface ElementOccurrenceRecord {
  id: string;
  element_id: string;
  node_id: string;
  block_id: string;
  spans_json: string;
  created_at: string;
  updated_at: string;
}

export interface ElementBacklinkRecord {
  id: string;
  element_id: string;
  node_id: string;
  node_title: string;
  spans_json: string;
  created_at: string;
}

export interface ElementOccurrenceRepository {
  saveOccurrencesForNode(
    nodeId: string,
    elementMatches: Array<{
      elementId: string;
      matches: Array<{ text: string; position: number; length: number }>;
    }>
  ): Promise<void>;
  getOccurrencesByNode(nodeId: string): Promise<ElementOccurrenceRecord[]>;
  getOccurrencesByElement(elementId: string): Promise<ElementBacklinkRecord[]>;
  deleteOccurrencesByNode(nodeId: string): Promise<void>;
  deleteOccurrencesByElement(elementId: string): Promise<void>;
  countOccurrencesByElement(elementId: string): Promise<number>;
}

function toOccurrenceRecord(
  row: typeof ElementOccurrenceTable.$inferSelect,
): ElementOccurrenceRecord {
  return {
    id: row.id,
    element_id: row.elementId,
    node_id: row.nodeId,
    block_id: row.blockId,
    spans_json: row.spansJson,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function createElementOccurrenceRepository(_projectId?: string): ElementOccurrenceRepository {
  const saveOccurrencesForNode = async (
    nodeId: string,
    elementMatches: Array<{
      elementId: string;
      matches: Array<{ text: string; position: number; length: number }>;
    }>
  ): Promise<void> => {
    const db = getDb();
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      await tx.delete(ElementOccurrenceTable).where(eq(ElementOccurrenceTable.nodeId, nodeId));

      const rows = elementMatches
        .filter((m) => m.matches.length > 0)
        .map((m) => ({
          id: uuidv7(),
          elementId: m.elementId,
          nodeId,
          blockId: '',
          spansJson: JSON.stringify(m.matches),
          createdAt: now,
          updatedAt: now,
        }));

      if (rows.length > 0) {
        await tx.insert(ElementOccurrenceTable).values(rows);
      }
    });
  };

  const getOccurrencesByNode = async (nodeId: string): Promise<ElementOccurrenceRecord[]> => {
    const rows = await getDb()
      .select()
      .from(ElementOccurrenceTable)
      .where(eq(ElementOccurrenceTable.nodeId, nodeId))
      .orderBy(desc(ElementOccurrenceTable.createdAt));

    return rows.map(toOccurrenceRecord);
  };

  const getOccurrencesByElement = async (elementId: string): Promise<ElementBacklinkRecord[]> => {
    const rows = await getDb()
      .select({
        id: ElementOccurrenceTable.id,
        element_id: ElementOccurrenceTable.elementId,
        node_id: ElementOccurrenceTable.nodeId,
        node_title: BookNodeTable.title,
        spans_json: ElementOccurrenceTable.spansJson,
        created_at: ElementOccurrenceTable.createdAt,
      })
      .from(ElementOccurrenceTable)
      .leftJoin(BookNodeTable, eq(ElementOccurrenceTable.nodeId, BookNodeTable.id))
      .where(eq(ElementOccurrenceTable.elementId, elementId))
      .orderBy(desc(ElementOccurrenceTable.createdAt));

    return rows.map((row) => ({
      id: row.id,
      element_id: row.element_id,
      node_id: row.node_id,
      node_title: row.node_title ?? '',
      spans_json: row.spans_json,
      created_at: row.created_at,
    }));
  };

  const deleteOccurrencesByNode = async (nodeId: string): Promise<void> => {
    await getDb().delete(ElementOccurrenceTable).where(eq(ElementOccurrenceTable.nodeId, nodeId));
  };

  const deleteOccurrencesByElement = async (elementId: string): Promise<void> => {
    await getDb().delete(ElementOccurrenceTable).where(eq(ElementOccurrenceTable.elementId, elementId));
  };

  const countOccurrencesByElement = async (elementId: string): Promise<number> => {
    const rows = await getDb()
      .select({
        count: sql<number>`count(distinct ${ElementOccurrenceTable.nodeId})`,
      })
      .from(ElementOccurrenceTable)
      .where(eq(ElementOccurrenceTable.elementId, elementId));

    return Number(rows[0]?.count ?? 0);
  };

  return {
    saveOccurrencesForNode,
    getOccurrencesByNode,
    getOccurrencesByElement,
    deleteOccurrencesByNode,
    deleteOccurrencesByElement,
    countOccurrencesByElement,
  };
}
