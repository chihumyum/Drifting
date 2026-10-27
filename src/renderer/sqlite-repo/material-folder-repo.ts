/**
 * Local SQLite repo for material folders. Thin CRUD; tree derivation lives in
 * domain/material-folder.ts and orchestration in usecase/useMaterialFolder.ts.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { MaterialFolderTable } from '../schema/drizzle';
import type { MaterialFolder } from '../domain/material-folder';

export type MaterialFolderUpdateData = Partial<Pick<MaterialFolder, 'name' | 'parentFolderId'>> & {
  updatedAt: string;
};

export interface MaterialFolderRepository {
  findById(id: string): Promise<MaterialFolder | null>;
  findAll(): Promise<MaterialFolder[]>;
  create(input: MaterialFolder): Promise<MaterialFolder>;
  update(id: string, data: MaterialFolderUpdateData): Promise<MaterialFolder | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof MaterialFolderTable.$inferSelect): MaterialFolder {
  return {
    id: record.id,
    projectId: record.projectId,
    name: record.name,
    parentFolderId: record.parentFolderId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createMaterialFolderRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): MaterialFolderRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<MaterialFolder | null> => {
    const rows = await dbProvider()
      .select()
      .from(MaterialFolderTable)
      .where(and(eq(MaterialFolderTable.id, id), eq(MaterialFolderTable.projectId, projectId)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    findById,

    findAll: async () => {
      const rows = await dbProvider()
        .select()
        .from(MaterialFolderTable)
        .where(eq(MaterialFolderTable.projectId, projectId))
        .orderBy(asc(MaterialFolderTable.createdAt));
      return rows.map(toDomain);
    },

    create: async (input) => {
      if (input.projectId !== projectId) throw new Error('Material folder projectId mismatch');
      await dbProvider().insert(MaterialFolderTable).values(input);
      return (await findById(input.id))!;
    },

    update: async (id, data) => {
      const values: Partial<typeof MaterialFolderTable.$inferInsert> = { updatedAt: data.updatedAt };
      if (data.name !== undefined) values.name = data.name;
      if (data.parentFolderId !== undefined) values.parentFolderId = data.parentFolderId;
      await dbProvider()
        .update(MaterialFolderTable)
        .set(values)
        .where(and(eq(MaterialFolderTable.id, id), eq(MaterialFolderTable.projectId, projectId)));
      return findById(id);
    },

    delete: async (id) => {
      await dbProvider()
        .delete(MaterialFolderTable)
        .where(and(eq(MaterialFolderTable.id, id), eq(MaterialFolderTable.projectId, projectId)));
      return true;
    },
  };
}
