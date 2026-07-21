import { and, eq } from 'drizzle-orm';
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';
import type { AssetUploadJob, AssetUploadStage } from '../domain/asset-upload-job';
import type { BookElement } from '../domain/book-element';
import type { LibraryItem } from '../domain/library-item';
import type { ProjectAsset, ProjectAssetOwnerKind } from '../domain/project-asset';
import { getDb, type DbTransaction } from '../lib/db';
import { platform } from '../platform';
import {
  BookElementTable,
  EntityRelationTable,
  LibraryItemTable,
  LocalSyncMutationTable,
} from '../schema/drizzle';
import { createAssetUploadJobRepository } from '../sqlite-repo/asset-upload-job-repo';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { createProjectAssetSqliteRepository } from '../sqlite-repo/project-asset-repo';
import { useDataStore } from '../store/data-store';
import { withAtomicSyncTransaction } from '../usecase/sync-helpers';
import { assetCacheService, extForMime } from './asset-cache.service';
import { cleanupAssetUploadLocalFiles } from './asset-upload-local-cleanup';
import {
  assertAssetUploadTransition,
  assetUploadRecoveryAction,
  shouldRefreshIncompleteUpload,
} from './asset-upload-state-machine';
import { forceFlush } from './entity-sync.service';
import { libraryItemServerPayload } from './library-item-sync-boundary';
import {
  projectAssetService,
  type ElementPortraitUploadResponse,
  type LibraryMaterialUploadResponse,
} from './project-asset.service';

type PendingAssetUploadResponse =
  | Extract<ElementPortraitUploadResponse, { uploadState: 'pending' }>
  | Extract<LibraryMaterialUploadResponse, { uploadState: 'pending' }>;

type CreatedAssetUpload =
  | { state: 'pending'; job: AssetUploadJob; upload: PendingAssetUploadResponse }
  | { state: 'ready'; job: AssetUploadJob; asset: ProjectAsset };

const log = loglevel.getLogger('DurableAssetUpload');
log.setLevel(loglevel.levels.WARN);

const runningJobs = new Map<string, Promise<void>>();
const RESUME_UPLOAD_CONCURRENCY = 2;

class UploadCanceledError extends Error {
  constructor() {
    super('Asset upload was canceled');
    this.name = 'UploadCanceledError';
  }
}

type NewUploadJobInput = {
  projectId: string;
  ownerKind: ProjectAssetOwnerKind;
  ownerId: string;
  kind: 'image' | 'pdf';
  sourcePath: string;
  sourceSizeBytes?: number | null;
  previousAssetId?: string | null;
};

type PreparedCacheMetadata = Pick<
  AssetUploadJob,
  | 'sourceMime'
  | 'sourceSizeBytes'
  | 'displayMime'
  | 'displaySizeBytes'
  | 'thumbnailMime'
  | 'thumbnailSizeBytes'
  | 'width'
  | 'height'
>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const status = (response as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function isNotFound(error: unknown): boolean {
  return httpStatus(error) === 404;
}

function makeUploadJob(input: NewUploadJobInput): AssetUploadJob {
  const now = new Date().toISOString();
  return {
    id: uuidv7(),
    projectId: input.projectId,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    kind: input.kind,
    role: input.ownerKind === 'element' ? 'element_portrait' : 'library_material',
    stage: 'queued',
    sourcePath: input.sourcePath,
    sourceMime: input.kind === 'pdf' ? 'application/pdf' : null,
    sourceSizeBytes: input.sourceSizeBytes ?? null,
    displayMime: null,
    displaySizeBytes: null,
    thumbnailMime: null,
    thumbnailSizeBytes: null,
    width: null,
    height: null,
    assetId: null,
    previousAssetId: input.previousAssetId ?? null,
    deletePreviousAssetOnCancel: false,
    attemptCount: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeLibraryMaterialUploadJob(input: {
  projectId: string;
  libraryItemId: string;
  kind: 'image' | 'pdf';
  sourcePath: string;
  sourceSizeBytes?: number | null;
}): AssetUploadJob {
  return makeUploadJob({
    projectId: input.projectId,
    ownerKind: 'library_item',
    ownerId: input.libraryItemId,
    kind: input.kind,
    sourcePath: input.sourcePath,
    sourceSizeBytes: input.sourceSizeBytes,
  });
}

function publishJobState(job: AssetUploadJob): void {
  const state = useDataStore.getState();
  if (job.stage === 'cleanup' || job.stage === 'canceled') {
    if (job.ownerKind === 'library_item') state.clearLibraryItemUploadState(job.ownerId);
    else state.clearElementPortraitUploadState(job.ownerId);
    return;
  }
  const visible = job.lastError
    ? ({ state: 'failed', error: job.lastError } as const)
    : ({ state: 'uploading' } as const);
  if (job.ownerKind === 'library_item') state.setLibraryItemUploadState(job.ownerId, visible);
  else state.setElementPortraitUploadState(job.ownerId, visible);
}

function clearJobState(job: Pick<AssetUploadJob, 'ownerKind' | 'ownerId'>): void {
  const state = useDataStore.getState();
  if (job.ownerKind === 'library_item') state.clearLibraryItemUploadState(job.ownerId);
  else state.clearElementPortraitUploadState(job.ownerId);
}

async function transitionJob(
  job: AssetUploadJob,
  stage: AssetUploadStage,
  patch: Partial<Omit<AssetUploadJob, 'id' | 'projectId' | 'ownerKind' | 'ownerId'>> = {},
): Promise<AssetUploadJob> {
  assertAssetUploadTransition(job.stage, stage);
  const updated = await createAssetUploadJobRepository(job.projectId).transition(
    job.id,
    job.stage,
    {
      ...patch,
      stage,
      updatedAt: new Date().toISOString(),
    },
  );
  if (!updated) throw new UploadCanceledError();
  publishJobState(updated);
  return updated;
}

async function currentRunnableJob(job: AssetUploadJob): Promise<AssetUploadJob> {
  const current = await createAssetUploadJobRepository(job.projectId).findById(job.id);
  if (!current || current.stage === 'canceled') throw new UploadCanceledError();
  return current;
}

async function ownerStillExists(job: AssetUploadJob): Promise<boolean> {
  if (job.ownerKind === 'library_item') {
    const rows = await getDb()
      .select({ id: LibraryItemTable.id })
      .from(LibraryItemTable)
      .where(
        and(eq(LibraryItemTable.id, job.ownerId), eq(LibraryItemTable.projectId, job.projectId)),
      )
      .limit(1);
    return rows.length > 0;
  }
  const rows = await getDb()
    .select({ id: BookElementTable.id })
    .from(BookElementTable)
    .where(and(eq(BookElementTable.id, job.ownerId), eq(BookElementTable.projectId, job.projectId)))
    .limit(1);
  return rows.length > 0;
}

async function requireOwner(job: AssetUploadJob): Promise<void> {
  if (await ownerStillExists(job)) return;
  const repo = createAssetUploadJobRepository(job.projectId);
  const current = await repo.findById(job.id);
  if (current && current.stage !== 'canceled') {
    const canceled = await repo.update(current.id, {
      stage: 'canceled',
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    if (canceled) clearJobState(canceled);
  }
  throw new UploadCanceledError();
}

async function writePreparedCache(job: AssetUploadJob): Promise<PreparedCacheMetadata> {
  if (job.kind === 'image') {
    const prepared = await platform.material.prepareImage(job.sourcePath);
    if (!prepared.ok) throw new Error(prepared.error);
    const { source, display, thumbnail } = prepared;
    const sourceExt = extForMime(source.mime, 'png');
    await Promise.all([
      assetCacheService.copyFile(job.projectId, job.id, 'source', sourceExt, job.sourcePath),
      assetCacheService.writeBytes(job.projectId, job.id, 'display', 'jpg', display.bytes),
      assetCacheService.writeBytes(
        job.projectId,
        job.id,
        'thumbnail',
        'jpg',
        thumbnail.bytes,
      ),
    ]);
    return {
      sourceMime: source.mime,
      sourceSizeBytes: source.sizeBytes,
      displayMime: display.mime,
      displaySizeBytes: display.sizeBytes,
      thumbnailMime: thumbnail.mime,
      thumbnailSizeBytes: thumbnail.sizeBytes,
      width: source.width,
      height: source.height,
    };
  }

  const thumbnail = await platform.material.createThumbnailVariant(job.sourcePath, 512, 72);
  if (!thumbnail.ok) throw new Error(thumbnail.error);
  const [sourceCache] = await Promise.all([
    assetCacheService.copyFile(job.projectId, job.id, 'source', 'pdf', job.sourcePath),
    assetCacheService.writeBytes(
      job.projectId,
      job.id,
      'thumbnail',
      'jpg',
      thumbnail.bytes,
    ),
  ]);
  return {
    sourceMime: 'application/pdf',
    sourceSizeBytes: sourceCache.sizeBytes,
    displayMime: null,
    displaySizeBytes: null,
    thumbnailMime: thumbnail.mime,
    thumbnailSizeBytes: thumbnail.sizeBytes,
    width: null,
    height: null,
  };
}

async function prepareJob(job: AssetUploadJob): Promise<AssetUploadJob> {
  const current = await transitionJob(job, 'preparing', { lastError: null });
  await requireOwner(current);
  const metadata = await writePreparedCache(current);
  return transitionJob(current, 'cached', { ...metadata, lastError: null });
}

async function ensureOwnerExistsOnServer(job: AssetUploadJob): Promise<void> {
  await requireOwner(job);
  // Asset-create endpoints validate their owner. The placeholder/create outbox
  // entry must therefore commit first; forceFlush is followed by a row check
  // because network failures intentionally leave the outbox durable instead of
  // throwing from forceFlush.
  await forceFlush();
  const entityType = job.ownerKind === 'element' ? 'element' : 'libraryItem';
  const pending = await getDb()
    .select({ status: LocalSyncMutationTable.status, lastError: LocalSyncMutationTable.lastError })
    .from(LocalSyncMutationTable)
    .where(
      and(
        eq(LocalSyncMutationTable.projectId, job.projectId),
        eq(LocalSyncMutationTable.entityType, entityType),
        eq(LocalSyncMutationTable.entityId, job.ownerId),
      ),
    )
    .limit(1);
  if (pending[0]) {
    throw new Error(pending[0].lastError || 'Waiting for the owner to sync before uploading');
  }
}

function requirePrepared(job: AssetUploadJob): asserts job is AssetUploadJob & {
  sourceMime: string;
  sourceSizeBytes: number;
  thumbnailMime: string;
  thumbnailSizeBytes: number;
} {
  if (!job.sourceMime || !job.sourceSizeBytes || !job.thumbnailMime || !job.thumbnailSizeBytes) {
    throw new Error('Asset upload cache metadata is incomplete');
  }
  if (job.kind === 'image' && (!job.displayMime || !job.displaySizeBytes)) {
    throw new Error('Image display cache metadata is incomplete');
  }
}

async function persistReadyAssetForBinding(
  job: AssetUploadJob,
  asset: ProjectAsset,
): Promise<AssetUploadJob> {
  if (asset.id !== job.id) {
    throw new Error('Server asset id does not match the durable upload id');
  }
  assertAssetUploadTransition(job.stage, 'binding');
  const persisted = await getDb().transaction(async (tx) => {
    await createProjectAssetSqliteRepository(job.projectId, tx).upsert(asset);
    const transitioned = await createAssetUploadJobRepository(job.projectId, tx).transition(
      job.id,
      job.stage,
      {
        stage: 'binding',
        assetId: asset.id,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    );
    if (!transitioned) throw new UploadCanceledError();
    return transitioned;
  });
  useDataStore.getState().upsertProjectAsset(asset);
  publishJobState(persisted);
  return persisted;
}

async function createFreshAsset(job: AssetUploadJob): Promise<CreatedAssetUpload> {
  requirePrepared(job);
  await ensureOwnerExistsOnServer(job);

  const upload =
    job.ownerKind === 'element'
      ? await projectAssetService.createElementPortraitUpload(job.projectId, {
          uploadId: job.id,
          elementId: job.ownerId,
          sourceMime: job.sourceMime,
          sourceSizeBytes: job.sourceSizeBytes,
          displayMime: job.displayMime!,
          displaySizeBytes: job.displaySizeBytes!,
          thumbnailMime: job.thumbnailMime,
          thumbnailSizeBytes: job.thumbnailSizeBytes,
          width: job.width,
          height: job.height,
        })
      : await projectAssetService.createLibraryMaterialUpload(job.projectId, {
          uploadId: job.id,
          libraryItemId: job.ownerId,
          kind: job.kind,
          sourceMime: job.sourceMime,
          sourceSizeBytes: job.sourceSizeBytes,
          displayMime: job.displayMime,
          displaySizeBytes: job.displaySizeBytes,
          thumbnailMime: job.thumbnailMime,
          thumbnailSizeBytes: job.thumbnailSizeBytes,
          width: job.width,
          height: job.height,
        });

  if (upload.asset.id !== job.id) {
    throw new Error('Server asset id does not match the durable upload id');
  }
  if (upload.uploadState === 'ready') {
    return {
      state: 'ready',
      job: await persistReadyAssetForBinding(job, upload.asset),
      asset: upload.asset,
    };
  }
  await createProjectAssetSqliteRepository(job.projectId).upsert(upload.asset);
  useDataStore.getState().upsertProjectAsset(upload.asset);
  return {
    state: 'pending',
    job: await transitionJob(job, 'uploading', {
      assetId: upload.asset.id,
      lastError: null,
    }),
    upload,
  };
}

async function uploadCachedVariants(
  job: AssetUploadJob,
  upload: PendingAssetUploadResponse,
): Promise<AssetUploadJob> {
  requirePrepared(job);
  const sourceExt = extForMime(job.sourceMime, job.kind === 'pdf' ? 'pdf' : 'png');
  await Promise.all([
    assetCacheService.uploadFile({
      url: upload.uploads.source.url,
      projectId: job.projectId,
      assetId: job.id,
      variant: 'source',
      ext: sourceExt,
      contentType: upload.uploads.source.contentType,
    }),
    upload.uploads.display
      ? assetCacheService.uploadFile({
          url: upload.uploads.display.url,
          projectId: job.projectId,
          assetId: job.id,
          variant: 'display',
          ext: 'jpg',
          contentType: upload.uploads.display.contentType,
        })
      : Promise.resolve(0),
    assetCacheService.uploadFile({
      url: upload.uploads.thumbnail.url,
      projectId: job.projectId,
      assetId: job.id,
      variant: 'thumbnail',
      ext: 'jpg',
      contentType: upload.uploads.thumbnail.contentType,
    }),
  ]);
  return transitionJob(await currentRunnableJob(job), 'completing', { lastError: null });
}

async function removeLocalAsset(projectId: string, assetId: string): Promise<void> {
  await createProjectAssetSqliteRepository(projectId).delete(assetId);
  useDataStore.getState().removeProjectAsset(assetId);
  await assetCacheService.deleteAsset(projectId, assetId);
}

async function deleteServerAsset(projectId: string, assetId: string): Promise<void> {
  try {
    await projectAssetService.deleteAsset(projectId, assetId);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function refreshIncompleteUpload(job: AssetUploadJob): Promise<AssetUploadJob> {
  // `job.id` is the server upload id. Returning to cached and calling create
  // again reuses the pending row while obtaining fresh presigned URLs. Never
  // delete that row here: deleted upload ids are intentionally not reusable.
  return transitionJob(job, 'cached', { assetId: null, lastError: null });
}

async function completeExistingAsset(job: AssetUploadJob): Promise<{
  job: AssetUploadJob;
  asset: ProjectAsset;
}> {
  if (!job.assetId) throw new Error('Asset upload has no server asset');
  await requireOwner(job);
  const asset = await projectAssetService.completeUpload(job.projectId, job.assetId);
  const current = await currentRunnableJob(job);
  return {
    job: await persistReadyAssetForBinding(current, asset),
    asset,
  };
}

async function validateCanonicalUploadCache(
  job: AssetUploadJob,
  asset: ProjectAsset,
): Promise<void> {
  requirePrepared(job);
  if (asset.id !== job.id) {
    throw new Error('Server asset id does not match the durable upload id');
  }
  const sourceExt = extForMime(job.sourceMime, job.kind === 'pdf' ? 'pdf' : 'png');
  const source = await assetCacheService.getCachedPath(job.projectId, job.id, 'source', sourceExt);
  const thumbnail = await assetCacheService.getCachedPath(
    job.projectId,
    job.id,
    'thumbnail',
    'jpg',
  );
  if (!source || !thumbnail) throw new Error('Durable asset upload cache is incomplete');
  if (source.sizeBytes !== job.sourceSizeBytes || thumbnail.sizeBytes !== job.thumbnailSizeBytes) {
    throw new Error('Durable asset upload cache size does not match persisted metadata');
  }
  if (job.kind === 'image') {
    const display = await assetCacheService.getCachedPath(job.projectId, job.id, 'display', 'jpg');
    if (!display) throw new Error('Durable image display cache is incomplete');
    if (display.sizeBytes !== job.displaySizeBytes) {
      throw new Error('Durable image display cache size does not match persisted metadata');
    }
  }
}

function preparedMetadataMatchesJob(
  job: AssetUploadJob,
  metadata: PreparedCacheMetadata,
): boolean {
  return (
    metadata.sourceMime === job.sourceMime &&
    metadata.sourceSizeBytes === job.sourceSizeBytes &&
    metadata.displayMime === job.displayMime &&
    metadata.displaySizeBytes === job.displaySizeBytes &&
    metadata.thumbnailMime === job.thumbnailMime &&
    metadata.thumbnailSizeBytes === job.thumbnailSizeBytes &&
    metadata.width === job.width &&
    metadata.height === job.height
  );
}

async function ensureCanonicalUploadCache(
  job: AssetUploadJob,
  asset: ProjectAsset,
): Promise<void> {
  try {
    await validateCanonicalUploadCache(job, asset);
    return;
  } catch (validationError) {
    try {
      const rebuilt = await writePreparedCache(job);
      if (!preparedMetadataMatchesJob(job, rebuilt)) {
        throw new Error('Rebuilt upload cache metadata differs from the ready asset');
      }
      await validateCanonicalUploadCache(job, asset);
      return;
    } catch (importRepairError) {
      // The import may have disappeared or a codec upgrade may produce
      // different derivatives. R2 is canonical after ready, so discard the
      // bad local cache and recover exact variants from the server.
      await assetCacheService.deleteAsset(job.projectId, job.id);
      const variants: Array<'source' | 'display' | 'thumbnail'> = [
        'source',
        'thumbnail',
      ];
      if (job.kind === 'image') variants.push('display');
      try {
        await Promise.all(
          variants.map((variant) =>
            assetCacheService.ensureCachedVariant(job.projectId, asset, variant),
          ),
        );
        await validateCanonicalUploadCache(job, asset);
      } catch (downloadRepairError) {
        throw new AggregateError(
          [validationError, importRepairError, downloadRepairError],
          'Ready asset cache could not be recovered',
        );
      }
    }
  }
}

async function bindReadyAsset(job: AssetUploadJob, asset: ProjectAsset): Promise<AssetUploadJob> {
  await ensureCanonicalUploadCache(job, asset);
  const bound = await withAtomicSyncTransaction(job.projectId, async (tx, sync) => {
    const current = await createAssetUploadJobRepository(job.projectId, tx).findById(job.id);
    if (!current || current.stage === 'canceled' || current.assetId !== asset.id) {
      throw new UploadCanceledError();
    }
    await createProjectAssetSqliteRepository(job.projectId, tx).upsert(asset);
    const updatedAt = new Date().toISOString();
    let libraryItem: LibraryItem | null = null;
    let element: BookElement | null = null;
    if (job.ownerKind === 'library_item') {
      const itemRepo = createLibraryItemSqliteRepository(job.projectId, tx);
      const existing = await itemRepo.findById(job.ownerId);
      if (!existing) throw new UploadCanceledError();
      libraryItem = await itemRepo.update(job.ownerId, {
        source: 'r2',
        uri: `asset://${asset.id}`,
        localPath: null,
        assetId: asset.id,
        mime: job.sourceMime,
        sizeBytes: job.sourceSizeBytes,
        thumbnailUri: null,
        updatedAt,
      });
      if (!libraryItem) throw new UploadCanceledError();
      await sync(
        'libraryItem',
        'update',
        libraryItem.id,
        job.projectId,
        libraryItemServerPayload(libraryItem),
      );
      const relations = await tx
        .select()
        .from(EntityRelationTable)
        .where(
          and(
            eq(EntityRelationTable.projectId, job.projectId),
            eq(EntityRelationTable.fromKind, 'library_item'),
            eq(EntityRelationTable.fromId, job.ownerId),
          ),
        );
      for (const relation of relations) {
        await sync('entityRelation', 'create', relation.id, job.projectId, {
          id: relation.id,
          fromKind: relation.fromKind,
          fromId: relation.fromId,
          toKind: relation.toKind,
          toId: relation.toId,
          kind: relation.kind,
        });
      }
    } else {
      element = await createBookElementSqliteRepository(job.projectId, tx).update(job.ownerId, {
        portraitAssetId: asset.id,
        updatedAt,
      });
      if (!element) throw new UploadCanceledError();
      await sync('element', 'update', job.ownerId, job.projectId, {
        portraitAssetId: asset.id,
      });
    }
    const persistedJob = await createAssetUploadJobRepository(job.projectId, tx).update(job.id, {
      stage: 'cleanup',
      lastError: null,
      updatedAt,
    });
    return { job: persistedJob, libraryItem, element };
  });

  if (!bound.job) throw new UploadCanceledError();
  useDataStore.getState().upsertProjectAsset(asset);
  if (bound.libraryItem) {
    useDataStore.getState().updateLibraryItem(bound.libraryItem.id, bound.libraryItem);
  }
  if (bound.element) {
    useDataStore.getState().updateBookElement(bound.element.id, bound.element);
  }
  publishJobState(bound.job);
  return bound.job;
}

async function cleanupJob(job: AssetUploadJob): Promise<void> {
  const repo = createAssetUploadJobRepository(job.projectId);
  const current = (await repo.findById(job.id)) ?? job;

  if (current.stage === 'canceled') {
    // A create request may have committed even when its response (and thus the
    // local assetId transition) was lost. The stable upload id lets cancel
    // reclaim that row safely; DELETE 404 is success.
    const assetId = current.assetId ?? current.id;
    await deleteServerAsset(current.projectId, assetId);
    await createProjectAssetSqliteRepository(current.projectId).delete(assetId);
    useDataStore.getState().removeProjectAsset(assetId);
    if (
      current.deletePreviousAssetOnCancel &&
      current.previousAssetId &&
      current.previousAssetId !== assetId
    ) {
      await deleteServerAsset(current.projectId, current.previousAssetId);
      await removeLocalAsset(current.projectId, current.previousAssetId);
    }
  }
  if (current.stage === 'cleanup' && current.previousAssetId) {
    await deleteServerAsset(current.projectId, current.previousAssetId);
    await removeLocalAsset(current.projectId, current.previousAssetId);
  }
  await cleanupAssetUploadLocalFiles(current);
  await repo.delete(current.id);
  clearJobState(current);
}

async function failJob(job: AssetUploadJob, error: unknown): Promise<void> {
  const repo = createAssetUploadJobRepository(job.projectId);
  const current = await repo.findById(job.id);
  if (!current) return;
  const failed = await repo.update(current.id, {
    lastError: errorMessage(error),
    updatedAt: new Date().toISOString(),
  });
  if (failed) publishJobState(failed);
}

async function finishCanceledJobCleanup(job: AssetUploadJob): Promise<void> {
  await cleanupJob(job).catch(async (cleanupError) => {
    log.warn(`Canceled upload job ${job.id} still needs cleanup:`, cleanupError);
    await failJob(job, cleanupError);
  });
}

async function runUploadJob(initial: AssetUploadJob): Promise<void> {
  let job =
    (await createAssetUploadJobRepository(initial.projectId).findById(initial.id)) ?? initial;
  const shouldRefreshUpload = shouldRefreshIncompleteUpload(job);
  try {
    if (job.stage === 'canceled' || job.stage === 'cleanup') {
      await cleanupJob(job);
      return;
    }
    job =
      (await createAssetUploadJobRepository(job.projectId).update(job.id, {
        attemptCount: job.attemptCount + 1,
        lastError: null,
        updatedAt: new Date().toISOString(),
      })) ?? job;
    publishJobState(job);

    let action = assetUploadRecoveryAction(job);
    if (action === 'prepare') {
      job = await prepareJob(job);
      action = 'create_asset';
    }

    let readyAsset: ProjectAsset | null = null;
    if (action === 'try_complete') {
      try {
        const completed = await completeExistingAsset(job);
        job = completed.job;
        readyAsset = completed.asset;
        action = 'bind';
      } catch (error) {
        if (error instanceof UploadCanceledError) throw error;
        // First recovery pass preserves a possibly-complete asset and retries
        // HEAD/finalize later. A prior failed attempt proves this pending upload
        // needs fresh presigned URLs, so the next pass reopens the same upload id.
        if (!shouldRefreshUpload) throw error;
        job = await refreshIncompleteUpload(await currentRunnableJob(job));
        action = 'create_asset';
      }
    }

    if (action === 'create_asset') {
      const created = await createFreshAsset(job);
      job = created.job;
      if (created.state === 'ready') {
        readyAsset = created.asset;
      } else {
        job = await uploadCachedVariants(job, created.upload);
        const completed = await completeExistingAsset(job);
        job = completed.job;
        readyAsset = completed.asset;
      }
      action = 'bind';
    }

    if (action === 'bind') {
      if (!readyAsset) {
        if (!job.assetId) throw new Error('Ready upload lost its asset id');
        const localAsset = await createProjectAssetSqliteRepository(job.projectId).findById(
          job.assetId,
        );
        if (localAsset?.status === 'ready') {
          readyAsset = localAsset;
        } else {
          const completed = await completeExistingAsset(job);
          job = completed.job;
          readyAsset = completed.asset;
        }
      }
      job = await bindReadyAsset(await currentRunnableJob(job), readyAsset);
      action = 'cleanup';
    }

    if (action === 'cleanup') await cleanupJob(job);
  } catch (error) {
    const repo = createAssetUploadJobRepository(job.projectId);
    let latest = await repo.findById(job.id);
    if (latest?.stage === 'canceled') {
      await finishCanceledJobCleanup(latest);
      return;
    }
    if (error instanceof UploadCanceledError) {
      if (latest?.stage === 'cleanup') {
        await cleanupJob(latest).catch(async (cleanupError) => {
          log.warn(`Completed upload job ${latest!.id} still needs cleanup:`, cleanupError);
          await failJob(latest!, cleanupError);
        });
      } else if (latest) {
        latest = await repo.update(latest.id, {
          stage: 'canceled',
          lastError: null,
          updatedAt: new Date().toISOString(),
        });
        if (latest) await finishCanceledJobCleanup(latest);
      } else {
        // The project row may already have cascaded the job. Best-effort remote
        // cleanup closes the race with an in-flight create/complete request.
        await deleteServerAsset(job.projectId, job.assetId ?? job.id).catch(() => undefined);
      }
      return;
    }
    log.warn(`Upload job ${job.id} paused at ${job.stage}:`, error);
    await failJob(latest ?? job, error);
  }
}

function scheduleJob(job: AssetUploadJob): Promise<void> {
  const existing = runningJobs.get(job.id);
  if (existing) return existing;
  const run = runUploadJob(job).finally(() => {
    if (runningJobs.get(job.id) === run) runningJobs.delete(job.id);
  });
  runningJobs.set(job.id, run);
  return run;
}

export async function queueElementPortraitUpload(input: {
  projectId: string;
  elementId: string;
  sourcePath: string;
  sourceSizeBytes?: number | null;
  previousAssetId?: string | null;
}): Promise<AssetUploadJob> {
  const repo = createAssetUploadJobRepository(input.projectId);
  const existing = await repo.findByOwner('element', input.elementId);
  if (existing) {
    if (existing.stage === 'cleanup' || existing.stage === 'canceled') {
      await scheduleJob(existing);
      if (await repo.findByOwner('element', input.elementId)) {
        throw new Error('The previous portrait upload still needs cleanup');
      }
    } else if (existing.lastError) {
      const canceled = await cancelAssetUploadForOwner(input.projectId, 'element', input.elementId);
      if (canceled) await scheduleJob(canceled);
      if (await repo.findByOwner('element', input.elementId)) {
        throw new Error('The previous portrait upload could not be cleaned up');
      }
    } else {
      throw new Error('An element portrait upload is already in progress');
    }
  }
  const job = makeUploadJob({
    projectId: input.projectId,
    ownerKind: 'element',
    ownerId: input.elementId,
    kind: 'image',
    sourcePath: input.sourcePath,
    sourceSizeBytes: input.sourceSizeBytes,
    previousAssetId: input.previousAssetId,
  });
  const persisted = await repo.create(job);
  publishJobState(persisted);
  void scheduleJob(persisted);
  return persisted;
}

export async function hydrateAssetUploadStates(projectId: string): Promise<AssetUploadJob[]> {
  const jobs = await createAssetUploadJobRepository(projectId).findAll();
  const library: Record<string, { state: 'uploading' } | { state: 'failed'; error: string }> = {};
  const portraits: Record<string, { state: 'uploading' } | { state: 'failed'; error: string }> = {};
  for (const job of jobs) {
    if (job.stage === 'cleanup' || job.stage === 'canceled') continue;
    const visible = job.lastError
      ? ({ state: 'failed', error: job.lastError } as const)
      : ({ state: 'uploading' } as const);
    if (job.ownerKind === 'library_item') library[job.ownerId] = visible;
    else portraits[job.ownerId] = visible;
  }
  useDataStore.getState().replaceAssetUploadStates(library, portraits);
  return jobs;
}

export async function resumeProjectAssetUploads(projectId: string): Promise<void> {
  const jobs = await hydrateAssetUploadStates(projectId);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex++];
      if (job) await scheduleJob(job);
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(RESUME_UPLOAD_CONCURRENCY, jobs.length) }, worker),
  );
}

export async function retryAssetUploadForOwner(
  projectId: string,
  ownerKind: ProjectAssetOwnerKind,
  ownerId: string,
): Promise<void> {
  const job = await createAssetUploadJobRepository(projectId).findByOwner(ownerKind, ownerId);
  if (!job) throw new Error('No resumable asset upload was found');
  await scheduleJob(job);
}

export async function cancelAssetUploadForOwner(
  projectId: string,
  ownerKind: ProjectAssetOwnerKind,
  ownerId: string,
  tx?: DbTransaction,
  options: { deletePreviousAsset?: boolean } = {},
): Promise<AssetUploadJob | null> {
  const repo = createAssetUploadJobRepository(projectId, tx);
  const job = await repo.findByOwner(ownerKind, ownerId);
  if (!job) return null;
  if (job.stage === 'cleanup' && !options.deletePreviousAsset) {
    return job;
  }
  const canceled = await repo.update(job.id, {
    stage: 'canceled',
    deletePreviousAssetOnCancel:
      job.deletePreviousAssetOnCancel || Boolean(options.deletePreviousAsset),
    lastError: null,
    updatedAt: new Date().toISOString(),
  });
  if (canceled) clearJobState(canceled);
  if (!tx && canceled) void scheduleJob(canceled);
  return canceled;
}

/**
 * Mark every job before deleting its project and remove the job-owned local
 * cache while the project row still exists. Remote pending assets are covered
 * by the server's project-deletion lifecycle; no signed request is persisted.
 */
export async function cancelAssetUploadsForProjectDeletion(projectId: string): Promise<void> {
  const repo = createAssetUploadJobRepository(projectId);
  const jobs = await repo.findAll();
  for (const job of jobs) {
    await repo.update(job.id, {
      stage: 'canceled',
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    await cleanupAssetUploadLocalFiles({ ...job, stage: 'canceled' });
    clearJobState(job);
  }
}

export async function insertAssetUploadJobInTransaction(
  tx: DbTransaction,
  job: AssetUploadJob,
): Promise<AssetUploadJob> {
  return createAssetUploadJobRepository(job.projectId, tx).create(job);
}

export function startAssetUploadJob(job: AssetUploadJob): void {
  publishJobState(job);
  void scheduleJob(job);
}
