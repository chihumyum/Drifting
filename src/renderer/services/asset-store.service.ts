import type { ProjectAsset, ProjectAssetVariant } from '../domain/project-asset';
import { platform } from '../platform';

export type StoredAssetFile = {
  filePath: string;
  fileUrl: string;
  sizeBytes: number;
};

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
};

function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const normalized = mime.split(';')[0]?.trim().toLowerCase();
  return normalized || null;
}

export function extForMime(mime: string | null | undefined, fallback = 'bin'): string {
  const normalized = normalizeMime(mime);
  return normalized ? (EXT_BY_MIME[normalized] ?? fallback) : fallback;
}

export function projectAssetVariantExt(
  asset: ProjectAsset,
  variant: ProjectAssetVariant,
): string {
  return variant === 'source' ? extForMime(asset.sourceMime) : 'jpg';
}

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

  async requireVariant(
    projectId: string,
    asset: ProjectAsset,
    variant: ProjectAssetVariant,
  ): Promise<StoredAssetFile> {
    const stored = await assetStoreService.getPath(
      projectId,
      asset.id,
      variant,
      projectAssetVariantExt(asset, variant),
    );
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
