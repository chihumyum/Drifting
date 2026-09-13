import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  LibraryAssetItem,
  LibraryItem,
  LibraryItemPatch,
  LibraryTextItem,
  LibraryUrlItem,
} from '../domain/library-item';
import { getDb, type DbExecutor } from '../lib/db';
import { LibraryItemTable } from '../schema/drizzle';

export type LibraryItemCreateData = LibraryItem;
export type LibraryItemUpdateData = LibraryItemPatch & { updatedAt: string };

export interface LibraryItemRepository {
  findById(id: string): Promise<LibraryItem | null>;
  findAll(ids?: readonly string[]): Promise<LibraryItem[]>;
  findOrderedIds(): Promise<string[]>;
  create(input: LibraryItemCreateData): Promise<LibraryItem>;
  update(id: string, data: LibraryItemUpdateData): Promise<LibraryItem | null>;
  delete(id: string): Promise<boolean>;
}

function base(record: typeof LibraryItemTable.$inferSelect) {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    notesJson: record.notesJson,
    orderKey: record.orderKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toDomain(record: typeof LibraryItemTable.$inferSelect): LibraryItem {
  if (record.kind === 'image' || record.kind === 'pdf') {
    if (!record.assetId) throw new Error(`Library asset item ${record.id} has no asset binding`);
    return {
      ...base(record),
      kind: record.kind,
      assetId: record.assetId,
      externalUrl: null,
      previewImageUrl: null,
      bodyJson: null,
    } satisfies LibraryAssetItem;
  }
  if (record.kind === 'url') {
    if (!record.externalUrl) throw new Error(`Library URL item ${record.id} has no URL`);
    return {
      ...base(record),
      kind: 'url',
      assetId: null,
      externalUrl: record.externalUrl,
      previewImageUrl: record.previewImageUrl,
      bodyJson: null,
    } satisfies LibraryUrlItem;
  }
  if (record.kind === 'text') {
    return {
      ...base(record),
      kind: 'text',
      assetId: null,
      externalUrl: null,
      previewImageUrl: null,
      bodyJson: record.bodyJson,
    } satisfies LibraryTextItem;
  }
  throw new Error(`Unsupported library item kind: ${record.kind}`);
}

export function createLibraryItemSqliteRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): LibraryItemRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<LibraryItem | null> => {
    const rows = await dbProvider()
      .select()
      .from(LibraryItemTable)
      .where(and(eq(LibraryItemTable.id, id), eq(LibraryItemTable.projectId, projectId)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    findById,
    async findAll(ids) {
      if (ids?.length === 0) return [];
      const rows = await dbProvider()
        .select()
        .from(LibraryItemTable)
        .where(and(eq(LibraryItemTable.projectId, projectId), ids ? inArray(LibraryItemTable.id, [...ids]) : undefined))
        .orderBy(asc(LibraryItemTable.orderKey), desc(LibraryItemTable.updatedAt), asc(sql`${LibraryItemTable}.rowid`));
      return rows.map(toDomain);
    },
    async findOrderedIds() {
      const rows = await dbProvider().select({ id: LibraryItemTable.id }).from(LibraryItemTable)
        .where(eq(LibraryItemTable.projectId, projectId))
        .orderBy(asc(LibraryItemTable.orderKey), desc(LibraryItemTable.updatedAt), asc(sql`${LibraryItemTable}.rowid`));
      return rows.map(({ id }) => id);
    },
    async create(input) {
      if (input.projectId !== projectId) {
        throw new Error(`Cannot create a library item for project ${input.projectId} in ${projectId}`);
      }
      await dbProvider().insert(LibraryItemTable).values(input);
      return (await findById(input.id))!;
    },
    async update(id, data) {
      const updateValues: Partial<typeof LibraryItemTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.title !== undefined) updateValues.title = data.title;
      if (data.bodyJson !== undefined) updateValues.bodyJson = data.bodyJson;
      if (data.notesJson !== undefined) updateValues.notesJson = data.notesJson;
      if (data.previewImageUrl !== undefined)
        updateValues.previewImageUrl = data.previewImageUrl;
      if (data.orderKey !== undefined) updateValues.orderKey = data.orderKey;

      await dbProvider()
        .update(LibraryItemTable)
        .set(updateValues)
        .where(and(eq(LibraryItemTable.id, id), eq(LibraryItemTable.projectId, projectId)));
      return findById(id);
    },
    async delete(id) {
      const existing = await findById(id);
      if (!existing) return false;
      await dbProvider()
        .delete(LibraryItemTable)
        .where(and(eq(LibraryItemTable.id, id), eq(LibraryItemTable.projectId, projectId)));
      return true;
    },
  };
}
