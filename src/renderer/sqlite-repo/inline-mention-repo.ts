import { v7 as uuidv7 } from 'uuid';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  InlineMentionTable,
  StorylineTable,
} from '../schema/drizzle';
import type { EntityKind, StructuralEntityKind } from '../domain/entity-kinds';

// Inline mentions are the projection of @-mark / auto-detect-mark spans in any
// entity's body content (typically structural manuscripts, but memo / material
// bodies can also host marks). Only the TARGET is constrained to a structural
// entity — memo / material never appear as the to-side of an inline mention.
// Source-of-truth is the document JSON; rows here are rebuilt on every save by
// reference-projection.service.

export interface InlineMentionRecord {
  id: string;
  projectId: string;
  fromKind: EntityKind;
  fromId: string;
  fromBlockId: string;
  fromSpansJson: string;
  toKind: StructuralEntityKind;
  toId: string;
  createdAt: string;
  updatedAt: string;
}

// One draft per (fromBlock, toEntity). Spans inside the same block share a row.
export interface InlineMentionDraft {
  fromBlockId: string;
  fromSpansJson: string;
  toKind: StructuralEntityKind;
  toId: string;
}

// Backlink projection joined with the from-entity's display title — used by
// ReferencesPanel to show "X processes mention me".
export interface InlineMentionBacklink {
  id: string;
  fromKind: EntityKind;
  fromId: string;
  fromBlockId: string;
  fromSpansJson: string;
  fromTitle: string;
  toKind: StructuralEntityKind;
  toId: string;
  createdAt: string;
}

export interface InlineMentionRepository {
  replaceMentionsFromSource(
    projectId: string,
    fromKind: EntityKind,
    fromId: string,
    drafts: InlineMentionDraft[],
  ): Promise<void>;

  listMentionsFromSource(
    fromKind: EntityKind,
    fromId: string,
  ): Promise<InlineMentionRecord[]>;

  listBacklinksToTarget(
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<InlineMentionBacklink[]>;

  countDistinctSourcesByTarget(
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<number>;

  deleteAllForTarget(toKind: StructuralEntityKind, toId: string): Promise<void>;
  deleteAllForSource(fromKind: EntityKind, fromId: string): Promise<void>;
}

function toRecord(
  row: typeof InlineMentionTable.$inferSelect,
): InlineMentionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    fromKind: row.fromKind as EntityKind,
    fromId: row.fromId,
    fromBlockId: row.fromBlockId,
    fromSpansJson: row.fromSpansJson,
    toKind: row.toKind as StructuralEntityKind,
    toId: row.toId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createInlineMentionRepository(dbOverride?: DbExecutor): InlineMentionRepository {
  const dbProvider = () => dbOverride ?? getDb();
  const replaceMentionsFromSource = async (
    projectId: string,
    fromKind: EntityKind,
    fromId: string,
    drafts: InlineMentionDraft[],
  ): Promise<void> => {
    const now = new Date().toISOString();
    const replace = async (executor: DbExecutor) => {
      await executor
        .delete(InlineMentionTable)
        .where(
          and(
            eq(InlineMentionTable.fromKind, fromKind),
            eq(InlineMentionTable.fromId, fromId),
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
        createdAt: now,
        updatedAt: now,
      }));
      await executor.insert(InlineMentionTable).values(rows);
    };

    if (dbOverride) {
      await replace(dbOverride);
      return;
    }
    await getDb().transaction(replace);
  };

  const listMentionsFromSource = async (
    fromKind: EntityKind,
    fromId: string,
  ): Promise<InlineMentionRecord[]> => {
    const rows = await dbProvider()
      .select()
      .from(InlineMentionTable)
      .where(
        and(
          eq(InlineMentionTable.fromKind, fromKind),
          eq(InlineMentionTable.fromId, fromId),
        ),
      )
      .orderBy(desc(InlineMentionTable.createdAt));
    return rows.map(toRecord);
  };

  // Patches have no stable display name here yet, so they fall back to empty.
  const listBacklinksToTarget = async (
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<InlineMentionBacklink[]> => {
    const rows = await dbProvider()
      .select({
        id: InlineMentionTable.id,
        fromKind: InlineMentionTable.fromKind,
        fromId: InlineMentionTable.fromId,
        fromBlockId: InlineMentionTable.fromBlockId,
        fromSpansJson: InlineMentionTable.fromSpansJson,
        toKind: InlineMentionTable.toKind,
        toId: InlineMentionTable.toId,
        createdAt: InlineMentionTable.createdAt,
        nodeTitle: BookNodeTable.title,
        elementName: BookElementTable.name,
        categoryName: ElementCategoryTable.name,
        storylineName: StorylineTable.name,
      })
      .from(InlineMentionTable)
      .leftJoin(
        BookNodeTable,
        and(
          eq(InlineMentionTable.fromKind, 'node'),
          eq(InlineMentionTable.fromId, BookNodeTable.id),
        ),
      )
      .leftJoin(
        BookElementTable,
        and(
          eq(InlineMentionTable.fromKind, 'element'),
          eq(InlineMentionTable.fromId, BookElementTable.id),
        ),
      )
      .leftJoin(
        ElementCategoryTable,
        and(
          eq(InlineMentionTable.fromKind, 'category'),
          eq(InlineMentionTable.fromId, ElementCategoryTable.id),
        ),
      )
      .leftJoin(
        StorylineTable,
        and(
          eq(InlineMentionTable.fromKind, 'storyline'),
          eq(InlineMentionTable.fromId, StorylineTable.id),
        ),
      )
      .where(
        and(
          eq(InlineMentionTable.toKind, toKind),
          eq(InlineMentionTable.toId, toId),
        ),
      )
      .orderBy(desc(InlineMentionTable.createdAt));

    return rows.map((row) => ({
      id: row.id,
      fromKind: row.fromKind as EntityKind,
      fromId: row.fromId,
      fromBlockId: row.fromBlockId,
      fromSpansJson: row.fromSpansJson,
      fromTitle:
        row.nodeTitle ?? row.elementName ?? row.categoryName ?? row.storylineName ?? '',
      toKind: row.toKind as StructuralEntityKind,
      toId: row.toId,
      createdAt: row.createdAt,
    }));
  };

  const countDistinctSourcesByTarget = async (
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<number> => {
    const rows = await dbProvider()
      .select({
        count: sql<number>`count(distinct ${InlineMentionTable.fromKind} || ':' || ${InlineMentionTable.fromId})`,
      })
      .from(InlineMentionTable)
      .where(
        and(
          eq(InlineMentionTable.toKind, toKind),
          eq(InlineMentionTable.toId, toId),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  };

  const deleteAllForTarget = async (
    toKind: StructuralEntityKind,
    toId: string,
  ): Promise<void> => {
    await dbProvider()
      .delete(InlineMentionTable)
      .where(
        and(
          eq(InlineMentionTable.toKind, toKind),
          eq(InlineMentionTable.toId, toId),
        ),
      );
  };

  const deleteAllForSource = async (
    fromKind: EntityKind,
    fromId: string,
  ): Promise<void> => {
    await dbProvider()
      .delete(InlineMentionTable)
      .where(
        and(
          eq(InlineMentionTable.fromKind, fromKind),
          eq(InlineMentionTable.fromId, fromId),
        ),
      );
  };

  return {
    replaceMentionsFromSource,
    listMentionsFromSource,
    listBacklinksToTarget,
    countDistinctSourcesByTarget,
    deleteAllForTarget,
    deleteAllForSource,
  };
}
