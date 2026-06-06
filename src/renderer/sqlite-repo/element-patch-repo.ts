import { v7 as uuidv7 } from 'uuid';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../lib/db';
import { ElementPatchTable, BookNodeTable } from '../schema/drizzle';

export interface ElementPatch {
  id: string;
  projectId: string;
  elementId: string;
  sourceNodeId: string | null;
  sourceBlockId: string | null;
  // Plain-text snapshot of the sourceBlock at accept time. NULL when the
  // patch wasn't produced by Copilot or predates the column.
  sourceBlockText: string | null;
  title: string | null;
  contentJson: string;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}

// Hydrated read shape including the source chapter's title for display.
export interface PatchWithSourceTitle extends ElementPatch {
  sourceNodeTitle: string | null;
  // Source chapter's timeline position — drives Shadow's "effective canon at chapter N"
  // (a patch is in effect only from its source chapter onward). Null = floating/unordered
  // patch (no chapter anchor), treated as always-in-effect. narrativeOrder = author's
  // story-time axis (preferred); bookOrder = reading order (always present, fallback).
  sourceNarrativeOrder: number | null;
  sourceBookOrder: number | null;
}

export interface CreatePatchInput {
  projectId: string;
  elementId: string;
  sourceNodeId?: string | null;
  sourceBlockId?: string | null;
  sourceBlockText?: string | null;
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
    sourceBlockText: row.sourceBlockText,
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
      sourceBlockText: input.sourceBlockText ?? null,
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
    // NOTE: do NOT JOIN book_node here to grab its title. element_patch.title and
    // book_node.title are BOTH named "title", and better-sqlite3 collapses two
    // same-named result columns into one — silently dropping the patch's own
    // title and shifting every field after it (the patch then showed the chapter
    // number as its title, and the book_order as the chapter title). Resolve the
    // source-node title + order in a SEPARATE query instead.
    const rows = await getDb()
      .select()
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.elementId, elementId));

    const nodeIds = [...new Set(rows.map((r) => r.sourceNodeId).filter((x): x is string => !!x))];
    const nodes = nodeIds.length
      ? await getDb()
          .select({
            id: BookNodeTable.id,
            title: BookNodeTable.title,
            bookOrder: BookNodeTable.bookOrder,
            narrativeOrder: BookNodeTable.narrativeOrder,
          })
          .from(BookNodeTable)
          .where(inArray(BookNodeTable.id, nodeIds))
      : [];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const orderOf = (nodeId: string | null): number =>
      nodeId ? (nodeById.get(nodeId)?.bookOrder ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;

    return rows
      .map((row) => ({
        ...toDomain(row),
        sourceNodeTitle: row.sourceNodeId ? (nodeById.get(row.sourceNodeId)?.title ?? null) : null,
        sourceNarrativeOrder: row.sourceNodeId
          ? (nodeById.get(row.sourceNodeId)?.narrativeOrder ?? null)
          : null,
        sourceBookOrder: row.sourceNodeId
          ? (nodeById.get(row.sourceNodeId)?.bookOrder ?? null)
          : null,
      }))
      // Mirror the old ORDER BY: bookOrder, then orderKey, then createdAt;
      // floating patches (no source node) sort to the end.
      .sort(
        (a, b) =>
          orderOf(a.sourceNodeId) - orderOf(b.sourceNodeId) ||
          a.orderKey - b.orderKey ||
          a.createdAt.localeCompare(b.createdAt),
      );
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
