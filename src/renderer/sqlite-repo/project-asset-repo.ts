import { and, desc, eq } from 'drizzle-orm';
import type { ProjectAsset, ProjectAssetKind } from '../domain/project-asset';
import { getDb, type DbExecutor } from '../lib/db';
import { ProjectAssetTable } from '../schema/drizzle';

export interface ProjectAssetRepository {
  findById(id: string): Promise<ProjectAsset | null>;
  findAll(): Promise<ProjectAsset[]>;
  create(input: ProjectAsset): Promise<ProjectAsset>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof ProjectAssetTable.$inferSelect): ProjectAsset {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind as ProjectAssetKind,
    sourceMime: record.sourceMime,
    sourceSizeBytes: record.sourceSizeBytes,
    sourceSha256: record.sourceSha256,
    width: record.width,
    height: record.height,
    createdAt: record.createdAt,
  };
}

export function createProjectAssetSqliteRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): ProjectAssetRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<ProjectAsset | null> => {
    const rows = await dbProvider()
      .select()
      .from(ProjectAssetTable)
      .where(and(eq(ProjectAssetTable.id, id), eq(ProjectAssetTable.projectId, projectId)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  return {
    findById,
    async findAll() {
      const rows = await dbProvider()
        .select()
        .from(ProjectAssetTable)
        .where(eq(ProjectAssetTable.projectId, projectId))
        .orderBy(desc(ProjectAssetTable.createdAt));
      return rows.map(toDomain);
    },
    async create(input) {
      await dbProvider().insert(ProjectAssetTable).values(input);
      return (await findById(input.id))!;
    },
    async delete(id) {
      const existing = await findById(id);
      if (!existing) return false;
      await dbProvider()
        .delete(ProjectAssetTable)
        .where(and(eq(ProjectAssetTable.id, id), eq(ProjectAssetTable.projectId, projectId)));
      return true;
    },
  };
}
