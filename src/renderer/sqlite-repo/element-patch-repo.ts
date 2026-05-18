import { v7 as uuidv7 } from 'uuid';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { ElementPatchTable, BookNodeTable } from '../schema/drizzle';

export interface ElementPatch {
  id: string;
  projectId: string;
  elementId: string;
  sourceNodeId: string | null;
  sourceBlockId: string | null;
  title: string | null;
  contentJson: string;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}

// Hydrated read shape including the source chapter's title for display.
export interface PatchWithSourceTitle extends ElementPatch {
  sourceNodeTitle: string | null;
}

export interface CreatePatchInput {
  projectId: string;
  elementId: string;
  sourceNodeId?: string | null;
  sourceBlockId?: string | null;
  title?: string | null;
  contentJson?: string;
}

export type UpdatePatchInput = Partial<
  Pick<ElementPatch, 'sourceNodeId' | 'sourceBlockId' | 'title' | 'contentJson' | 'orderKey'>
>;

export interface ElementPatchRepository {
  create(input: CreatePatchInput): Promise<ElementPatch>;
  update(id: string, updates: UpdatePatchInput): Promise<ElementPatch | null>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<ElementPatch | null>;
  // Lists patches for one element, ordered by source node's bookOrder
  // then orderKey. Floating patches (no sourceNodeId) sort to the end.
  listByElement(elementId: string): Promise<PatchWithSourceTitle[]>;
  // Lists patches that originate from a specific chapter — used by the chapter
  // sidebar's "Patches from this chapter" section.
  listBySourceNode(sourceNodeId: string): Promise<ElementPatch[]>;
}

function toDomain(row: typeof ElementPatchTable.$inferSelect): ElementPatch {
  return {
    id: row.id,
    projectId: row.projectId,
    elementId: row.elementId,
    sourceNodeId: row.sourceNodeId,
    sourceBlockId: row.sourceBlockId,
    title: row.title,
    contentJson: row.contentJson,
    orderKey: row.orderKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createElementPatchRepository(): ElementPatchRepository {
  const create = async (input: CreatePatchInput): Promise<ElementPatch> => {
    const db = getDb();
    const now = new Date().toISOString();
    const row = {
      id: uuidv7(),
      projectId: input.projectId,
      elementId: input.elementId,
      sourceNodeId: input.sourceNodeId ?? null,
      sourceBlockId: input.sourceBlockId ?? null,
      title: input.title ?? null,
      contentJson: input.contentJson ?? '{}',
      orderKey: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(ElementPatchTable).values(row);
    return toDomain(row as typeof ElementPatchTable.$inferSelect);
  };

  const update = async (
    id: string,
    updates: UpdatePatchInput,
  ): Promise<ElementPatch | null> => {
    const db = getDb();
    const now = new Date().toISOString();
    const setValues: Record<string, unknown> = { updatedAt: now };
    if (updates.sourceNodeId !== undefined) setValues.sourceNodeId = updates.sourceNodeId;
    if (updates.sourceBlockId !== undefined) setValues.sourceBlockId = updates.sourceBlockId;
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.contentJson !== undefined) setValues.contentJson = updates.contentJson;
    if (updates.orderKey !== undefined) setValues.orderKey = updates.orderKey;

    await db.update(ElementPatchTable).set(setValues).where(eq(ElementPatchTable.id, id));
    const rows = await db
      .select()
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const deletePatch = async (id: string): Promise<void> => {
    await getDb().delete(ElementPatchTable).where(eq(ElementPatchTable.id, id));
  };

  const findById = async (id: string): Promise<ElementPatch | null> => {
    const rows = await getDb()
      .select()
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const listByElement = async (elementId: string): Promise<PatchWithSourceTitle[]> => {
    const rows = await getDb()
      .select({
        id: ElementPatchTable.id,
        projectId: ElementPatchTable.projectId,
        elementId: ElementPatchTable.elementId,
        sourceNodeId: ElementPatchTable.sourceNodeId,
        sourceBlockId: ElementPatchTable.sourceBlockId,
        title: ElementPatchTable.title,
        contentJson: ElementPatchTable.contentJson,
        orderKey: ElementPatchTable.orderKey,
        createdAt: ElementPatchTable.createdAt,
        updatedAt: ElementPatchTable.updatedAt,
        sourceNodeTitle: BookNodeTable.title,
        sourceNodeOrder: BookNodeTable.bookOrder,
      })
      .from(ElementPatchTable)
      .leftJoin(BookNodeTable, eq(ElementPatchTable.sourceNodeId, BookNodeTable.id))
      .where(eq(ElementPatchTable.elementId, elementId))
      .orderBy(
        asc(BookNodeTable.bookOrder),
        asc(ElementPatchTable.orderKey),
        asc(ElementPatchTable.createdAt),
      );
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      elementId: row.elementId,
      sourceNodeId: row.sourceNodeId,
      sourceBlockId: row.sourceBlockId,
      title: row.title,
      contentJson: row.contentJson,
      orderKey: row.orderKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceNodeTitle: row.sourceNodeTitle ?? null,
    }));
  };

  const listBySourceNode = async (sourceNodeId: string): Promise<ElementPatch[]> => {
    const rows = await getDb()
      .select()
      .from(ElementPatchTable)
      .where(and(eq(ElementPatchTable.sourceNodeId, sourceNodeId)))
      .orderBy(asc(ElementPatchTable.orderKey), asc(ElementPatchTable.createdAt));
    return rows.map(toDomain);
  };

  return {
    create,
    update,
    delete: deletePatch,
    findById,
    listByElement,
    listBySourceNode,
  };
}
