import { getDb, type DbExecutor } from '../lib/db';
import { ElementTagTable, ElementTagLinkTable } from '../schema/drizzle';
import { eq, asc, and, inArray } from 'drizzle-orm';
import type { ElementTag, ElementTagLink } from '../domain/element-tag';

function createDbProvider(dbOverride?: DbExecutor) {
  return () => dbOverride ?? getDb();
}

const elementTagsLink = ElementTagLinkTable;

export interface ElementTagRepository {
  findById(id: string): Promise<ElementTag | null>;
  findAll(projectId: string): Promise<ElementTag[]>;
  findByName(projectId: string, name: string): Promise<ElementTag | null>;
  create(data: ElementTag): Promise<ElementTag>;
  delete(id: string): Promise<boolean>;
}

export interface ElementTagLinkRepository {
  findTagsByElementId(elementId: string): Promise<ElementTag[]>;
  findTagIdsByElementId(elementId: string): Promise<string[]>;
  findTagIdsByElementIds(elementIds: string[]): Promise<Record<string, string[]>>;
  findElementIdsByTagId(tagId: string): Promise<string[]>;
  addTagToElement(elementId: string, tagId: string): Promise<ElementTagLink>;
  removeTagFromElement(elementId: string, tagId: string): Promise<boolean>;
  removeAllTagsFromElement(elementId: string): Promise<boolean>;
  setTagsForElement(elementId: string, tagIds: string[]): Promise<void>;
}

function elementTagRecordToDomain(record: typeof ElementTagTable.$inferSelect): ElementTag {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createElementTagRepository(dbOverride?: DbExecutor): ElementTagRepository {
  const dbProvider = createDbProvider(dbOverride);

  const findById = async (id: string): Promise<ElementTag | null> => {
    const rows = await dbProvider().select().from(ElementTagTable).where(eq(ElementTagTable.id, id)).limit(1);
    return rows[0] ? elementTagRecordToDomain(rows[0]) : null;
  };

  const findAll = async (projectId: string): Promise<ElementTag[]> => {
    const rows = await dbProvider().select().from(ElementTagTable)
      .where(eq(ElementTagTable.projectId, projectId))
      .orderBy(asc(ElementTagTable.name));
    return rows.map(elementTagRecordToDomain);
  };

  const findByName = async (projectId: string, name: string): Promise<ElementTag | null> => {
    const rows = await dbProvider().select().from(ElementTagTable)
      .where(and(eq(ElementTagTable.projectId, projectId), eq(ElementTagTable.name, name)))
      .limit(1);
    return rows[0] ? elementTagRecordToDomain(rows[0]) : null;
  };

  const create = async (data: ElementTag): Promise<ElementTag> => {
    const newTag: typeof ElementTagTable.$inferInsert = {
      id: data.id,
      projectId: data.projectId,
      name: data.name,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };

    await dbProvider().insert(ElementTagTable).values(newTag);
    return elementTagRecordToDomain(newTag as typeof ElementTagTable.$inferSelect);
  };

  const deleteTag = async (id: string): Promise<boolean> => {
    const result = await dbProvider().delete(ElementTagTable).where(eq(ElementTagTable.id, id));
    return (result as any).rowsAffected > 0;
  };

  return {
    findById,
    findAll,
    findByName,
    create,
    delete: deleteTag,
  };
}

export function createElementTagLinkRepository(dbOverride?: DbExecutor): ElementTagLinkRepository {
  const dbProvider = createDbProvider(dbOverride);

  const findTagsByElementId = async (elementId: string): Promise<ElementTag[]> => {
    const rows = await dbProvider().select({
      id: ElementTagTable.id,
      projectId: ElementTagTable.projectId,
      name: ElementTagTable.name,
      createdAt: ElementTagTable.createdAt,
      updatedAt: ElementTagTable.updatedAt,
    })
      .from(ElementTagTable)
      .innerJoin(elementTagsLink, eq(ElementTagTable.id, elementTagsLink.tagId))
      .where(eq(elementTagsLink.elementId, elementId))
      .orderBy(asc(ElementTagTable.name));

    return rows.map(elementTagRecordToDomain);
  };

  const findTagIdsByElementId = async (elementId: string): Promise<string[]> => {
    const rows = await dbProvider().select({ tagId: elementTagsLink.tagId })
      .from(elementTagsLink)
      .where(eq(elementTagsLink.elementId, elementId));
    return rows.map(r => r.tagId);
  };

  const findTagIdsByElementIds = async (elementIds: string[]): Promise<Record<string, string[]>> => {
    if (!elementIds.length) return {};

    const rows = await dbProvider().select({
      elementId: elementTagsLink.elementId,
      tagId: elementTagsLink.tagId,
    })
      .from(elementTagsLink)
      .where(inArray(elementTagsLink.elementId, elementIds));

    const map: Record<string, string[]> = {};
    for (const row of rows) {
      if (!map[row.elementId]) map[row.elementId] = [];
      map[row.elementId].push(row.tagId);
    }
    return map;
  };

  const findElementIdsByTagId = async (tagId: string): Promise<string[]> => {
    const rows = await dbProvider().select({ elementId: elementTagsLink.elementId })
      .from(elementTagsLink)
      .where(eq(elementTagsLink.tagId, tagId));
    return rows.map(r => r.elementId);
  };

  const addTagToElement = async (elementId: string, tagId: string): Promise<ElementTagLink> => {
    await dbProvider().insert(elementTagsLink)
      .values({ elementId, tagId })
      .onConflictDoNothing();
    return { elementId, tagId };
  };

  const removeTagFromElement = async (elementId: string, tagId: string): Promise<boolean> => {
    const result = await dbProvider().delete(elementTagsLink)
      .where(and(eq(elementTagsLink.elementId, elementId), eq(elementTagsLink.tagId, tagId)));
    return (result as any).rowsAffected > 0;
  };

  const removeAllTagsFromElement = async (elementId: string): Promise<boolean> => {
    const result = await dbProvider().delete(elementTagsLink)
      .where(eq(elementTagsLink.elementId, elementId));
    return (result as any).rowsAffected > 0;
  };

  const setTagsForElement = async (elementId: string, tagIds: string[]): Promise<void> => {
    await dbProvider().delete(elementTagsLink).where(eq(elementTagsLink.elementId, elementId));

    if (!tagIds.length) return;

    const rows = tagIds.map((tagId) => ({ elementId, tagId }));
    await dbProvider().insert(elementTagsLink).values(rows).onConflictDoNothing();
  };

  return {
    findTagsByElementId,
    findTagIdsByElementId,
    findTagIdsByElementIds,
    findElementIdsByTagId,
    addTagToElement,
    removeTagFromElement,
    removeAllTagsFromElement,
    setTagsForElement,
  };
}
