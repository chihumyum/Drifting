import { and, asc, eq } from 'drizzle-orm';
import type { AssetUploadJob, AssetUploadStage } from '../domain/asset-upload-job';
import type {
  ProjectAssetKind,
  ProjectAssetOwnerKind,
  ProjectAssetRole,
} from '../domain/project-asset';
import { getDb, type DbExecutor } from '../lib/db';
import { AssetUploadJobTable } from '../schema/drizzle';

export type AssetUploadJobUpdate = Partial<
  Omit<AssetUploadJob, 'id' | 'projectId' | 'ownerKind' | 'ownerId' | 'createdAt'>
> & { updatedAt: string };

export interface AssetUploadJobRepository {
  create(job: AssetUploadJob): Promise<AssetUploadJob>;
  findById(id: string): Promise<AssetUploadJob | null>;
  findByOwner(ownerKind: ProjectAssetOwnerKind, ownerId: string): Promise<AssetUploadJob | null>;
  findAll(): Promise<AssetUploadJob[]>;
  update(id: string, patch: AssetUploadJobUpdate): Promise<AssetUploadJob | null>;
  transition(
    id: string,
    expectedStage: AssetUploadStage,
    patch: AssetUploadJobUpdate & { stage: AssetUploadStage },
  ): Promise<AssetUploadJob | null>;
  delete(id: string): Promise<void>;
}

function toDomain(record: typeof AssetUploadJobTable.$inferSelect): AssetUploadJob {
  return {
    id: record.id,
    projectId: record.projectId,
    ownerKind: record.ownerKind as ProjectAssetOwnerKind,
    ownerId: record.ownerId,
    kind: record.kind as ProjectAssetKind,
    role: record.role as ProjectAssetRole,
    stage: record.stage as AssetUploadStage,
    sourcePath: record.sourcePath,
    sourceMime: record.sourceMime,
    sourceSizeBytes: record.sourceSizeBytes,
    displayMime: record.displayMime,
    displaySizeBytes: record.displaySizeBytes,
    thumbnailMime: record.thumbnailMime,
    thumbnailSizeBytes: record.thumbnailSizeBytes,
    width: record.width,
    height: record.height,
    assetId: record.assetId,
    previousAssetId: record.previousAssetId,
    deletePreviousAssetOnCancel: record.deletePreviousAssetOnCancel,
    attemptCount: record.attemptCount,
    lastError: record.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createAssetUploadJobRepository(
  projectId: string,
  dbOverride?: DbExecutor,
): AssetUploadJobRepository {
  const dbProvider = () => dbOverride ?? getDb();

  const findById = async (id: string): Promise<AssetUploadJob | null> => {
    const rows = await dbProvider()
      .select()
      .from(AssetUploadJobTable)
      .where(and(eq(AssetUploadJobTable.id, id), eq(AssetUploadJobTable.projectId, projectId)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  };

  const update = async (
    id: string,
    patch: AssetUploadJobUpdate,
  ): Promise<AssetUploadJob | null> => {
    const values: Partial<typeof AssetUploadJobTable.$inferInsert> = {
      updatedAt: patch.updatedAt,
    };
    if (patch.kind !== undefined) values.kind = patch.kind;
    if (patch.role !== undefined) values.role = patch.role;
    if (patch.stage !== undefined) values.stage = patch.stage;
    if (patch.sourcePath !== undefined) values.sourcePath = patch.sourcePath;
    if (patch.sourceMime !== undefined) values.sourceMime = patch.sourceMime;
    if (patch.sourceSizeBytes !== undefined) values.sourceSizeBytes = patch.sourceSizeBytes;
    if (patch.displayMime !== undefined) values.displayMime = patch.displayMime;
    if (patch.displaySizeBytes !== undefined) values.displaySizeBytes = patch.displaySizeBytes;
    if (patch.thumbnailMime !== undefined) values.thumbnailMime = patch.thumbnailMime;
    if (patch.thumbnailSizeBytes !== undefined)
      values.thumbnailSizeBytes = patch.thumbnailSizeBytes;
    if (patch.width !== undefined) values.width = patch.width;
    if (patch.height !== undefined) values.height = patch.height;
    if (patch.assetId !== undefined) values.assetId = patch.assetId;
    if (patch.previousAssetId !== undefined) values.previousAssetId = patch.previousAssetId;
    if (patch.deletePreviousAssetOnCancel !== undefined)
      values.deletePreviousAssetOnCancel = patch.deletePreviousAssetOnCancel;
    if (patch.attemptCount !== undefined) values.attemptCount = patch.attemptCount;
    if (patch.lastError !== undefined) values.lastError = patch.lastError;

    await dbProvider()
      .update(AssetUploadJobTable)
      .set(values)
      .where(and(eq(AssetUploadJobTable.id, id), eq(AssetUploadJobTable.projectId, projectId)));
    return findById(id);
  };

  return {
    create: async (job) => {
      await dbProvider().insert(AssetUploadJobTable).values(job);
      return (await findById(job.id))!;
    },
    findById,
    findByOwner: async (ownerKind, ownerId) => {
      const rows = await dbProvider()
        .select()
        .from(AssetUploadJobTable)
        .where(
          and(
            eq(AssetUploadJobTable.projectId, projectId),
            eq(AssetUploadJobTable.ownerKind, ownerKind),
            eq(AssetUploadJobTable.ownerId, ownerId),
          ),
        )
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
    findAll: async () => {
      const rows = await dbProvider()
        .select()
        .from(AssetUploadJobTable)
        .where(eq(AssetUploadJobTable.projectId, projectId))
        .orderBy(asc(AssetUploadJobTable.createdAt));
      return rows.map(toDomain);
    },
    update,
    transition: async (id, expectedStage, patch) => {
      const values: Partial<typeof AssetUploadJobTable.$inferInsert> = {
        ...patch,
      };
      const result = await dbProvider()
        .update(AssetUploadJobTable)
        .set(values)
        .where(
          and(
            eq(AssetUploadJobTable.id, id),
            eq(AssetUploadJobTable.projectId, projectId),
            eq(AssetUploadJobTable.stage, expectedStage),
          ),
        );
      if ((result as { rowsAffected: number }).rowsAffected !== 1) return null;
      const current = await findById(id);
      return current?.stage === patch.stage ? current : null;
    },
    delete: async (id) => {
      await dbProvider()
        .delete(AssetUploadJobTable)
        .where(and(eq(AssetUploadJobTable.id, id), eq(AssetUploadJobTable.projectId, projectId)));
    },
  };
}
