import { v7 as uuidv7 } from 'uuid';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
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
  // Precise text-fragment anchor (JSON CommentTextAnchor) when created by
  // selecting prose; NULL otherwise. See drizzle.ts for the full rationale.
  textAnchorJson: string | null;
  // ISO timestamp set when the anchored text was deleted from the source
  // chapter; NULL while the anchor still resolves. Invalidated patches are
  // hidden from Agent canon context but still shown (badged) in UI.
  invalidatedAt: string | null;
  title: string | null;
  contentJson: string;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
}

// Hydrated read shape including the source chapter's title for display.
export interface PatchWithSourceTitle extends ElementPatch {
  sourceNodeTitle: string | null;
  // Source chapter's timeline position — drives "effective canon at chapter N"
  // (a patch is in effect only from its source chapter onward). Null = floating/unordered
  // patch (no chapter anchor), treated as always-in-effect. narrativeOrder = author's
  // story-time axis (preferred); bookOrder = reading order (always present, fallback).
  sourceNarrativeOrder: number | null;
  sourceBookOrder: number | null;
}

export interface CreatePatchInput {
  /** Optional deterministic id for crash-recoverable renderer commands. */
  id?: string;
  projectId: string;
  elementId: string;
  sourceNodeId?: string | null;
  sourceBlockId?: string | null;
  sourceBlockText?: string | null;
  textAnchorJson?: string | null;
  title?: string | null;
  contentJson?: string;
}

export type UpdatePatchInput = Partial<
  Pick<
    ElementPatch,
    | 'sourceNodeId'
    | 'sourceBlockId'
    | 'textAnchorJson'
    | 'invalidatedAt'
    | 'title'
    | 'contentJson'
    | 'orderKey'
  >
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
    textAnchorJson: row.textAnchorJson,
    invalidatedAt: row.invalidatedAt,
    title: row.title,
    contentJson: row.contentJson,
    orderKey: row.orderKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createElementPatchRepository(dbOverride?: DbExecutor): ElementPatchRepository {
  const dbProvider = () => dbOverride ?? getDb();
  const create = async (input: CreatePatchInput): Promise<ElementPatch> => {
    const db = dbProvider();
    const now = new Date().toISOString();
    const row = {
      id: input.id ?? uuidv7(),
      projectId: input.projectId,
      elementId: input.elementId,
      sourceNodeId: input.sourceNodeId ?? null,
      sourceBlockId: input.sourceBlockId ?? null,
      sourceBlockText: input.sourceBlockText ?? null,
      textAnchorJson: input.textAnchorJson ?? null,
      invalidatedAt: null,
      title: input.title ?? null,
      contentJson: input.contentJson ?? '{}',
      orderKey: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(ElementPatchTable).values(row);
    return toDomain(row as typeof ElementPatchTable.$inferSelect);
  };

  const update = async (id: string, updates: UpdatePatchInput): Promise<ElementPatch | null> => {
    const db = dbProvider();
    const now = new Date().toISOString();
    const setValues: Record<string, unknown> = { updatedAt: now };
    if (updates.sourceNodeId !== undefined) setValues.sourceNodeId = updates.sourceNodeId;
    if (updates.sourceBlockId !== undefined) setValues.sourceBlockId = updates.sourceBlockId;
    if (updates.textAnchorJson !== undefined) setValues.textAnchorJson = updates.textAnchorJson;
    if (updates.invalidatedAt !== undefined) setValues.invalidatedAt = updates.invalidatedAt;
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
    await dbProvider().delete(ElementPatchTable).where(eq(ElementPatchTable.id, id));
  };

  const findById = async (id: string): Promise<ElementPatch | null> => {
    const rows = await dbProvider()
      .select()
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const listByElement = async (elementId: string): Promise<PatchWithSourceTitle[]> => {
    // NOTE: do NOT JOIN book_node here to grab its title. element_patch.title and
    // book_node.title are BOTH named "title". A wildcard JOIN produces duplicate
    // column names that cannot be represented safely by every SQLite transport,
    // silently dropping or shifting values. Resolve source title/order separately.
    const rows = await dbProvider()
      .select()
      .from(ElementPatchTable)
      .where(eq(ElementPatchTable.elementId, elementId));

    const nodeIds = [...new Set(rows.map((r) => r.sourceNodeId).filter((x): x is string => !!x))];
    const nodes = nodeIds.length
      ? await dbProvider()
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
      nodeId
        ? (nodeById.get(nodeId)?.bookOrder ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;

    return (
      rows
        .map((row) => ({
          ...toDomain(row),
          sourceNodeTitle: row.sourceNodeId
            ? (nodeById.get(row.sourceNodeId)?.title ?? null)
            : null,
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
        )
    );
  };

  const listBySourceNode = async (sourceNodeId: string): Promise<ElementPatch[]> => {
    const rows = await dbProvider()
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
