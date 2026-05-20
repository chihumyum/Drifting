import { getDb, type DbExecutor } from '../lib/db';
import { MaterialTable } from '../schema/drizzle';
import { eq, asc, desc } from 'drizzle-orm';
import type { Material, MaterialKind, MaterialSource } from '../domain/material';

export type MaterialCreateData = Material;
export type MaterialUpdateData = Partial<Omit<Material, 'id' | 'createdAt' | 'projectId'>> & {
  updatedAt: string;
};

export interface MaterialRepository {
  findById(id: string): Promise<Material | null>;
  findAll(): Promise<Material[]>;
  create(input: MaterialCreateData): Promise<Material>;
  update(id: string, data: MaterialUpdateData): Promise<Material | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof MaterialTable.$inferSelect): Material {
  return {
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    kind: record.kind as MaterialKind,
    source: record.source as MaterialSource,
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

export function createMaterialSqliteRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): MaterialRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<Material | null> => {
    const rows = await dbProvider()
      .select()
      .from(MaterialTable)
      .where(eq(MaterialTable.id, id))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const findAll = async (): Promise<Material[]> => {
    const rows = await dbProvider()
      .select()
      .from(MaterialTable)
      .where(eq(MaterialTable.projectId, projectId))
      .orderBy(asc(MaterialTable.orderKey), desc(MaterialTable.updatedAt));
    return rows.map(toDomain);
  };

  return {
    findById,
    findAll,
    create: async (input) => {
      const row: typeof MaterialTable.$inferInsert = {
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
      await dbProvider().insert(MaterialTable).values(row);
      return (await findById(input.id))!;
    },
    update: async (id, data) => {
      if (!data.updatedAt) throw new Error('updatedAt is required when updating a material');

      const updateValues: Partial<typeof MaterialTable.$inferInsert> = {
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

      await dbProvider().update(MaterialTable).set(updateValues).where(eq(MaterialTable.id, id));
      return findById(id);
    },
    delete: async (id) => {
      await dbProvider().delete(MaterialTable).where(eq(MaterialTable.id, id));
      return true;
    },
  };
}
