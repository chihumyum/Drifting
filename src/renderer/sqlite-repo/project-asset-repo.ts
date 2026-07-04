import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, type DbExecutor } from '../lib/db';
import { ProjectAssetTable } from '../schema/drizzle';
import type {
  ProjectAsset,
  ProjectAssetKind,
  ProjectAssetOwnerKind,
  ProjectAssetRole,
  ProjectAssetStatus,
} from '../domain/project-asset';

export type ProjectAssetCreateData = ProjectAsset;
export type ProjectAssetUpdateData = Partial<
  Omit<ProjectAsset, 'id' | 'createdAt' | 'projectId'>
> & { updatedAt: string };

export interface ProjectAssetRepository {
  findById(id: string): Promise<ProjectAsset | null>;
  findAll(): Promise<ProjectAsset[]>;
  upsert(input: ProjectAsset): Promise<ProjectAsset>;
  update(id: string, data: ProjectAssetUpdateData): Promise<ProjectAsset | null>;
  delete(id: string): Promise<boolean>;
}

function toDomain(record: typeof ProjectAssetTable.$inferSelect): ProjectAsset {
  return {
    id: record.id,
    projectId: record.projectId,
    kind: record.kind as ProjectAssetKind,
    role: record.role as ProjectAssetRole,
    ownerKind: record.ownerKind as ProjectAssetOwnerKind,
    ownerId: record.ownerId,
    status: record.status as ProjectAssetStatus,
    sourceObjectKey: record.sourceObjectKey,
    displayObjectKey: record.displayObjectKey,
    thumbnailObjectKey: record.thumbnailObjectKey,
    sourceMime: record.sourceMime,
    displayMime: record.displayMime,
    thumbnailMime: record.thumbnailMime,
    sourceSizeBytes: record.sourceSizeBytes,
    displaySizeBytes: record.displaySizeBytes,
    thumbnailSizeBytes: record.thumbnailSizeBytes,
    sourceSha256: record.sourceSha256,
    width: record.width,
    height: record.height,
    completedAt: record.completedAt,
    deletedAt: record.deletedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
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

  const findAll = async (): Promise<ProjectAsset[]> => {
    const rows = await dbProvider()
      .select()
      .from(ProjectAssetTable)
      .where(and(eq(ProjectAssetTable.projectId, projectId), isNull(ProjectAssetTable.deletedAt)))
      .orderBy(desc(ProjectAssetTable.updatedAt));
    return rows.map(toDomain);
  };

  const upsert = async (input: ProjectAsset): Promise<ProjectAsset> => {
    const row: typeof ProjectAssetTable.$inferInsert = {
      id: input.id,
      projectId: input.projectId,
      kind: input.kind,
      role: input.role,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      status: input.status,
      sourceObjectKey: input.sourceObjectKey,
      displayObjectKey: input.displayObjectKey,
      thumbnailObjectKey: input.thumbnailObjectKey,
      sourceMime: input.sourceMime,
      displayMime: input.displayMime,
      thumbnailMime: input.thumbnailMime,
      sourceSizeBytes: input.sourceSizeBytes,
      displaySizeBytes: input.displaySizeBytes,
      thumbnailSizeBytes: input.thumbnailSizeBytes,
      sourceSha256: input.sourceSha256,
      width: input.width,
      height: input.height,
      completedAt: input.completedAt,
      deletedAt: input.deletedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    await dbProvider().insert(ProjectAssetTable).values(row).onConflictDoUpdate({
      target: ProjectAssetTable.id,
      set: row,
    });
    return (await findById(input.id))!;
  };

  const update = async (id: string, data: ProjectAssetUpdateData): Promise<ProjectAsset | null> => {
    const updateValues: Partial<typeof ProjectAssetTable.$inferInsert> = {
      updatedAt: data.updatedAt,
    };
    if (data.kind !== undefined) updateValues.kind = data.kind;
    if (data.role !== undefined) updateValues.role = data.role;
    if (data.ownerKind !== undefined) updateValues.ownerKind = data.ownerKind;
    if (data.ownerId !== undefined) updateValues.ownerId = data.ownerId;
    if (data.status !== undefined) updateValues.status = data.status;
    if (data.sourceObjectKey !== undefined) updateValues.sourceObjectKey = data.sourceObjectKey;
    if (data.displayObjectKey !== undefined)
      updateValues.displayObjectKey = data.displayObjectKey;
    if (data.thumbnailObjectKey !== undefined)
      updateValues.thumbnailObjectKey = data.thumbnailObjectKey;
    if (data.sourceMime !== undefined) updateValues.sourceMime = data.sourceMime;
    if (data.displayMime !== undefined) updateValues.displayMime = data.displayMime;
    if (data.thumbnailMime !== undefined) updateValues.thumbnailMime = data.thumbnailMime;
    if (data.sourceSizeBytes !== undefined)
      updateValues.sourceSizeBytes = data.sourceSizeBytes;
    if (data.displaySizeBytes !== undefined)
      updateValues.displaySizeBytes = data.displaySizeBytes;
    if (data.thumbnailSizeBytes !== undefined)
      updateValues.thumbnailSizeBytes = data.thumbnailSizeBytes;
    if (data.sourceSha256 !== undefined) updateValues.sourceSha256 = data.sourceSha256;
    if (data.width !== undefined) updateValues.width = data.width;
    if (data.height !== undefined) updateValues.height = data.height;
    if (data.completedAt !== undefined) updateValues.completedAt = data.completedAt;
    if (data.deletedAt !== undefined) updateValues.deletedAt = data.deletedAt;

    await dbProvider()
      .update(ProjectAssetTable)
      .set(updateValues)
      .where(and(eq(ProjectAssetTable.id, id), eq(ProjectAssetTable.projectId, projectId)));
    return findById(id);
  };

  return {
    findById,
    findAll,
    upsert,
    update,
    delete: async (id) => {
      await dbProvider().delete(ProjectAssetTable).where(eq(ProjectAssetTable.id, id));
      return true;
    },
  };
}
