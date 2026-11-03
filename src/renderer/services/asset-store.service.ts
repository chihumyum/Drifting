import type { ProjectAsset, ProjectAssetKind, ProjectAssetVariant } from '../domain/project-asset';
import { platform } from '../platform';

export type StoredAssetFile = {
  filePath: string;
  fileUrl: string;
  sizeBytes: number;
};

export { extForMime } from '../lib/asset-mime';
import { extForMime } from '../lib/asset-mime';

export function projectAssetVariantExt(
  asset: ProjectAsset,
  variant: ProjectAssetVariant,
): string {
  return variant === 'source' ? extForMime(asset.sourceMime) : 'jpg';
}

/** The PDF thumbnail derivative, shared by import and rebuild. */
export const PDF_THUMBNAIL = { size: 512, quality: 72 } as const;

const DERIVED_VARIANTS: Record<ProjectAssetKind, readonly ProjectAssetVariant[]> = {
  image: ['display', 'thumbnail'],
  pdf: ['thumbnail'],
};

function assertOk<T extends { ok: true } | { ok: false; error: string }>(
  result: T,
): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<T, { ok: true }>;
}

const pendingAssetPersistence = new Set<Promise<unknown>>();

function trackAssetPersistence<T>(operation: Promise<T>): Promise<T> {
  pendingAssetPersistence.add(operation);
  void operation.then(
    () => pendingAssetPersistence.delete(operation),
    () => pendingAssetPersistence.delete(operation),
  );
  return operation;
}

/** Wait for every native asset mutation that is active or starts while draining. */
export async function flushPendingAssetPersistence(): Promise<void> {
  const failures: unknown[] = [];

  while (pendingAssetPersistence.size > 0) {
    const batch = [...pendingAssetPersistence];
    const results = await Promise.allSettled(batch);
    for (let index = 0; index < batch.length; index += 1) {
      pendingAssetPersistence.delete(batch[index]);
      const result = results[index];
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} local asset persistence operation(s) failed while flushing`,
    );
  }
}

/** Durable, local-only storage for canonical source bytes and their derivatives. */
export const assetStoreService = {
  beginImport(projectId: string, assetId: string): Promise<void> {
    return trackAssetPersistence(platform.assetStore.beginImport(projectId, assetId));
  },

  commitImport(projectId: string, assetId: string): Promise<void> {
    return trackAssetPersistence(platform.assetStore.commitImport(projectId, assetId));
  },

  gcOrphanImports(
    retainedAssets: Array<{ projectId: string; assetId: string }>,
  ): Promise<{ removedOrphans: number; clearedCommittedMarkers: number }> {
    return trackAssetPersistence(platform.assetStore.gcOrphanImports(retainedAssets));
  },

  async getPath(
    projectId: string,
    assetId: string,
    variant: ProjectAssetVariant,
    ext: string,
  ): Promise<StoredAssetFile | null> {
    const res = assertOk(await platform.assetStore.getPath(projectId, assetId, variant, ext));
    if (!res.exists || res.sizeBytes == null || res.sizeBytes <= 0) return null;
    return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
  },

  writeBytes(
    projectId: string,
    assetId: string,
    variant: ProjectAssetVariant,
    ext: string,
    bytes: ArrayBuffer | Uint8Array,
  ): Promise<StoredAssetFile> {
    return trackAssetPersistence(
      platform.assetStore.writeBytes(projectId, assetId, variant, ext, bytes).then((result) => {
        const res = assertOk(result);
        return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
      }),
    );
  },

  copyFile(
    projectId: string,
    assetId: string,
    variant: ProjectAssetVariant,
    ext: string,
    sourcePath: string,
  ): Promise<StoredAssetFile> {
    return trackAssetPersistence(
      platform.assetStore
        .copyFile(projectId, assetId, variant, ext, sourcePath)
        .then((result) => {
          const res = assertOk(result);
          return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
        }),
    );
  },

  /** A missing display or thumbnail is rebuilt from the source before it is reported missing. */
  async requireVariant(
    projectId: string,
    asset: ProjectAsset,
    variant: ProjectAssetVariant,
  ): Promise<StoredAssetFile> {
    const ext = projectAssetVariantExt(asset, variant);
    let stored = await assetStoreService.getPath(projectId, asset.id, variant, ext);
    if (!stored && DERIVED_VARIANTS[asset.kind].includes(variant)) {
      await rebuildDerivatives(projectId, asset);
      stored = await assetStoreService.getPath(projectId, asset.id, variant, ext);
    }
    if (!stored) throw new Error(`Local asset ${asset.id} is missing its ${variant} variant`);
    return stored;
  },

  deleteAsset(projectId: string, assetId: string): Promise<void> {
    return trackAssetPersistence(
      platform.assetStore.deleteAsset(projectId, assetId).then((result) => {
        assertOk(result);
      }),
    );
  },
};

const activeRebuilds = new Map<string, Promise<void>>();

/**
 * Sync and some book files carry only the source, so a library that received
 * an asset that way has no display or thumbnail until a read rebuilds them.
 * Concurrent reads of one asset share a single rebuild.
 */
function rebuildDerivatives(projectId: string, asset: ProjectAsset): Promise<void> {
  const key = `${projectId}:${asset.id}`;
  const active = activeRebuilds.get(key);
  if (active) return active;
  const rebuild = (async () => {
    const sourceExt = projectAssetVariantExt(asset, 'source');
    const source = await assetStoreService.getPath(projectId, asset.id, 'source', sourceExt);
    if (!source) return;
    const derivatives = await prepareDerivatives(asset.kind, source.filePath);
    // Deleting the asset removes its directory. A write after that would leave
    // an unmarked directory that restart GC never collects.
    if (!(await assetStoreService.getPath(projectId, asset.id, 'source', sourceExt))) return;
    await Promise.all(
      derivatives.map(([variant, bytes]) =>
        assetStoreService.writeBytes(projectId, asset.id, variant, 'jpg', bytes),
      ),
    );
  })().finally(() => activeRebuilds.delete(key));
  activeRebuilds.set(key, rebuild);
  return rebuild;
}

async function prepareDerivatives(
  kind: ProjectAssetKind,
  sourcePath: string,
): Promise<Array<[ProjectAssetVariant, ArrayBuffer]>> {
  if (kind === 'image') {
    const prepared = await platform.material.prepareImage(sourcePath);
    if (!prepared.ok) throw new Error(prepared.error);
    return [
      ['display', prepared.display.bytes],
      ['thumbnail', prepared.thumbnail.bytes],
    ];
  }
  const thumbnail = await platform.material.createThumbnailVariant(
    sourcePath,
    PDF_THUMBNAIL.size,
    PDF_THUMBNAIL.quality,
  );
  if (!thumbnail.ok) throw new Error(thumbnail.error);
  return [['thumbnail', thumbnail.bytes]];
}
