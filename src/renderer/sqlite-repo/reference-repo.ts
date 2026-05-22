import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntityReferenceTable,
  StorylineTable,
} from '../schema/drizzle';

// Re-export the canonical EntityKind union from the mark layer to keep the
// reference table's polymorphic columns in lock-step with what marks can
// produce. `category` and `storyline` are valid source kinds (their
// description content can mention other entities).
import type { EntityKind } from '../lib/extensions/entity-link';
export type { EntityKind };
export type LinkOrigin = 'manual' | 'auto' | 'ai';

// Raw row.
export interface EntityReferenceRecord {
  id: string;
  projectId: string;
  fromKind: EntityKind;
  fromId: string;
  fromBlockId: string | null;
  fromSpansJson: string | null;
  toKind: EntityKind;
  toId: string;
  toBlockId: string | null;
  origin: LinkOrigin;
  confidence: number | null;
  /** Free-form relation category. */
  kind: string | null;
  createdAt: string;
  updatedAt: string;
}

// Projection draft: one entry per (fromBlock, toEntity) pair. All spans of the
// same target inside the same block are aggregated into spansJson.
export interface InlineReferenceDraft {
  fromBlockId: string;
  fromSpansJson: string; // [{from, to, text}]
  toKind: EntityKind;
  toId: string;
  toBlockId: string | null;
  origin: LinkOrigin;
  confidence?: number | null;
}

// Read shape for backlink panels — joins to the from-entity's display name.
export interface BacklinkRecord {
  id: string;
  fromKind: EntityKind;
  fromId: string;
  fromBlockId: string | null;
  fromSpansJson: string | null;
  fromTitle: string;
  toKind: EntityKind;
  toId: string;
  toBlockId: string | null;
  origin: LinkOrigin;
  createdAt: string;
}

export interface ReferenceRepository {
  // Bulk replace all inline references that originate from a given source
  // document. Used by the projection pipeline after a save.
  replaceInlineReferencesFromSource(
    projectId: string,
    fromKind: EntityKind,
    fromId: string,
    drafts: InlineReferenceDraft[],
  ): Promise<void>;

  // Manual whole-entity (or whole→block) relations created by user UI.
  // fromBlockId is always null for manual relations.
  addManualRelation(
    projectId: string,
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
    toBlockId?: string | null,
  ): Promise<EntityReferenceRecord>;

  removeManualRelation(
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
  ): Promise<void>;

  // All inline + manual references *out of* a source document.
  listReferencesFromSource(
    fromKind: EntityKind,
    fromId: string,
  ): Promise<EntityReferenceRecord[]>;

  // Backlinks: all references *into* a target entity, joined with the
  // from-entity's display title (chapter title or element name).
  listBacklinksToTarget(
    toKind: EntityKind,
    toId: string,
  ): Promise<BacklinkRecord[]>;

  // Counts: number of distinct from-documents that reference this target.
  countDistinctSourcesByTarget(toKind: EntityKind, toId: string): Promise<number>;

  // Cleanup when a target entity is deleted (cascade isn't enforced by FK on
  // polymorphic columns, so we run an explicit delete).
  deleteAllForTarget(toKind: EntityKind, toId: string): Promise<void>;
  deleteAllForSource(fromKind: EntityKind, fromId: string): Promise<void>;
}

function toRecord(
  row: typeof EntityReferenceTable.$inferSelect,
): EntityReferenceRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    fromKind: row.fromKind as EntityKind,
    fromId: row.fromId,
    fromBlockId: row.fromBlockId,
    fromSpansJson: row.fromSpansJson,
    toKind: row.toKind as EntityKind,
    toId: row.toId,
    toBlockId: row.toBlockId,
    origin: row.origin as LinkOrigin,
    confidence: row.confidence,
    kind: row.kind ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createReferenceRepository(): ReferenceRepository {
  const replaceInlineReferencesFromSource = async (
    projectId: string,
    fromKind: EntityKind,
    fromId: string,
    drafts: InlineReferenceDraft[],
  ): Promise<void> => {
    const db = getDb();
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      // Inline rows are those with fromBlockId not null. Manual whole-entity
      // relations (fromBlockId IS NULL) are preserved through this replace.
      await tx
        .delete(EntityReferenceTable)
        .where(
          and(
            eq(EntityReferenceTable.fromKind, fromKind),
            eq(EntityReferenceTable.fromId, fromId),
            isNotNull(EntityReferenceTable.fromBlockId),
          ),
        );

      if (drafts.length === 0) return;

      const rows = drafts.map((d) => ({
        id: uuidv7(),
        projectId,
        fromKind,
        fromId,
        fromBlockId: d.fromBlockId,
        fromSpansJson: d.fromSpansJson,
        toKind: d.toKind,
        toId: d.toId,
        toBlockId: d.toBlockId,
        origin: d.origin,
        confidence: d.confidence ?? null,
        kind: null, // inline mention refs are uncategorised by default
        createdAt: now,
        updatedAt: now,
      }));
      await tx.insert(EntityReferenceTable).values(rows);
    });
  };

  const addManualRelation = async (
    projectId: string,
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
    toBlockId: string | null = null,
  ): Promise<EntityReferenceRecord> => {
    const db = getDb();
    const now = new Date().toISOString();
    const row = {
      id: uuidv7(),
      projectId,
      fromKind,
      fromId,
      fromBlockId: null,
      fromSpansJson: null,
      toKind,
      toId,
      toBlockId,
      origin: 'manual' as LinkOrigin,
      confidence: null,
      kind: null as string | null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(EntityReferenceTable).values(row);
    return toRecord(row as typeof EntityReferenceTable.$inferSelect);
  };

  const removeManualRelation = async (
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
  ): Promise<void> => {
    await getDb()
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.fromKind, fromKind),
          eq(EntityReferenceTable.fromId, fromId),
          eq(EntityReferenceTable.toKind, toKind),
          eq(EntityReferenceTable.toId, toId),
          isNull(EntityReferenceTable.fromBlockId),
        ),
      );
  };

  const listReferencesFromSource = async (
    fromKind: EntityKind,
    fromId: string,
  ): Promise<EntityReferenceRecord[]> => {
    const rows = await getDb()
      .select()
      .from(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.fromKind, fromKind),
          eq(EntityReferenceTable.fromId, fromId),
        ),
      )
      .orderBy(desc(EntityReferenceTable.createdAt));
    return rows.map(toRecord);
  };

  // From-entity display title for backlink panels. Patches don't have a
  // stable display name here yet, so they fall back to empty.
  const listBacklinksToTarget = async (
    toKind: EntityKind,
    toId: string,
  ): Promise<BacklinkRecord[]> => {
    const rows = await getDb()
      .select({
        id: EntityReferenceTable.id,
        fromKind: EntityReferenceTable.fromKind,
        fromId: EntityReferenceTable.fromId,
        fromBlockId: EntityReferenceTable.fromBlockId,
        fromSpansJson: EntityReferenceTable.fromSpansJson,
        toKind: EntityReferenceTable.toKind,
        toId: EntityReferenceTable.toId,
        toBlockId: EntityReferenceTable.toBlockId,
        origin: EntityReferenceTable.origin,
        createdAt: EntityReferenceTable.createdAt,
        nodeTitle: BookNodeTable.title,
        elementName: BookElementTable.name,
        categoryName: ElementCategoryTable.name,
        storylineName: StorylineTable.name,
      })
      .from(EntityReferenceTable)
      .leftJoin(
        BookNodeTable,
        and(
          eq(EntityReferenceTable.fromKind, 'node'),
          eq(EntityReferenceTable.fromId, BookNodeTable.id),
        ),
      )
      .leftJoin(
        BookElementTable,
        and(
          eq(EntityReferenceTable.fromKind, 'element'),
          eq(EntityReferenceTable.fromId, BookElementTable.id),
        ),
      )
      .leftJoin(
        ElementCategoryTable,
        and(
          eq(EntityReferenceTable.fromKind, 'category'),
          eq(EntityReferenceTable.fromId, ElementCategoryTable.id),
        ),
      )
      .leftJoin(
        StorylineTable,
        and(
          eq(EntityReferenceTable.fromKind, 'storyline'),
          eq(EntityReferenceTable.fromId, StorylineTable.id),
        ),
      )
      .where(
        and(
          eq(EntityReferenceTable.toKind, toKind),
          eq(EntityReferenceTable.toId, toId),
        ),
      )
      .orderBy(desc(EntityReferenceTable.createdAt));

    return rows.map((row) => ({
      id: row.id,
      fromKind: row.fromKind as EntityKind,
      fromId: row.fromId,
      fromBlockId: row.fromBlockId,
      fromSpansJson: row.fromSpansJson,
      fromTitle: row.nodeTitle ?? row.elementName ?? row.categoryName ?? row.storylineName ?? '',
      toKind: row.toKind as EntityKind,
      toId: row.toId,
      toBlockId: row.toBlockId,
      origin: row.origin as LinkOrigin,
      createdAt: row.createdAt,
    }));
  };

  const countDistinctSourcesByTarget = async (
    toKind: EntityKind,
    toId: string,
  ): Promise<number> => {
    const rows = await getDb()
      .select({
        count: sql<number>`count(distinct ${EntityReferenceTable.fromKind} || ':' || ${EntityReferenceTable.fromId})`,
      })
      .from(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.toKind, toKind),
          eq(EntityReferenceTable.toId, toId),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  };

  const deleteAllForTarget = async (
    toKind: EntityKind,
    toId: string,
  ): Promise<void> => {
    await getDb()
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.toKind, toKind),
          eq(EntityReferenceTable.toId, toId),
        ),
      );
  };

  const deleteAllForSource = async (
    fromKind: EntityKind,
    fromId: string,
  ): Promise<void> => {
    await getDb()
      .delete(EntityReferenceTable)
      .where(
        and(
          eq(EntityReferenceTable.fromKind, fromKind),
          eq(EntityReferenceTable.fromId, fromId),
        ),
      );
  };

  return {
    replaceInlineReferencesFromSource,
    addManualRelation,
    removeManualRelation,
    listReferencesFromSource,
    listBacklinksToTarget,
    countDistinctSourcesByTarget,
    deleteAllForTarget,
    deleteAllForSource,
  };
}
