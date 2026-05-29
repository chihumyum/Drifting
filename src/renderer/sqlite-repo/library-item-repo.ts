import { getDb, type DbExecutor } from '../lib/db';
import { LibraryItemTable } from '../schema/drizzle';
import { eq, asc, desc } from 'drizzle-orm';
import type { LibraryItem, LibraryItemKind, LibraryItemSource } from '../domain/library-item';

export type LibraryItemCreateData = LibraryItem;
export type LibraryItemUpdateData = Partial<Omit<LibraryItem, 'id' | 'createdAt' | 'projectId'>> & {
  updatedAt: string;
};

export interface LibraryItemRepository {
  findById(id: string): Promise<LibraryItem | null>;
  findAll(): Promise<LibraryItem[]>;
  create(input: LibraryItemCreateData): Promise<LibraryItem>;
  update(id: string, data: LibraryItemUpdateData): Promise<LibraryItem | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof LibraryItemTable.$inferSelect): LibraryItem {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    kind: record.kind as LibraryItemKind,
    source: record.source as LibraryItemSource,
    uri: record.uri,
    localPath: record.localPath,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    bodyJson: record.bodyJson,
    notesJson: record.notesJson,
    thumbnailUri: record.thumbnailUri,
    orderKey: record.orderKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
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
      .where(eq(LibraryItemTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<LibraryItem[]> => {
    const rows = await dbProvider()
      .select()
      .from(LibraryItemTable)
      .where(eq(LibraryItemTable.projectId, projectId))
      .orderBy(asc(LibraryItemTable.orderKey), desc(LibraryItemTable.updatedAt));
    return rows.map(toDomain);
  };

  return {
    findById,
    findAll,
    create: async (input) => {
      const row: typeof LibraryItemTable.$inferInsert = {
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        kind: input.kind,
        source: input.source,
        uri: input.uri,
        localPath: input.localPath,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        bodyJson: input.bodyJson,
        notesJson: input.notesJson,
        thumbnailUri: input.thumbnailUri,
        orderKey: input.orderKey,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      await dbProvider().insert(LibraryItemTable).values(row);
      return (await findById(input.id))!;
    },
    update: async (id, data) => {
      if (!data.updatedAt) throw new Error('updatedAt is required when updating a library item');

      const updateValues: Partial<typeof LibraryItemTable.$inferInsert> = {
        updatedAt: data.updatedAt,
      };
      if (data.title !== undefined) updateValues.title = data.title;
      if (data.kind !== undefined) updateValues.kind = data.kind;
      if (data.source !== undefined) updateValues.source = data.source;
      if (data.uri !== undefined) updateValues.uri = data.uri;
      if (data.localPath !== undefined) updateValues.localPath = data.localPath;
      if (data.mime !== undefined) updateValues.mime = data.mime;
      if (data.sizeBytes !== undefined) updateValues.sizeBytes = data.sizeBytes;
      if (data.bodyJson !== undefined) updateValues.bodyJson = data.bodyJson;
      if (data.notesJson !== undefined) updateValues.notesJson = data.notesJson;
      if (data.thumbnailUri !== undefined) updateValues.thumbnailUri = data.thumbnailUri;
      if (data.orderKey !== undefined) updateValues.orderKey = data.orderKey;

      await dbProvider().update(LibraryItemTable).set(updateValues).where(eq(LibraryItemTable.id, id));
      return findById(id);
    },
    delete: async (id) => {
      await dbProvider().delete(LibraryItemTable).where(eq(LibraryItemTable.id, id));
      return true;
    },
  };
}
