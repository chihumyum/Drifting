import type { ProjectAsset } from '../domain/project-asset';
import { platform } from '../platform';
import { projectAssetService, type AssetVariant } from './project-asset.service';

type CachedFile = {
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
  'image/heic': 'heic',
  'image/heif': 'heif',
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

export function projectAssetVariantMime(asset: ProjectAsset, variant: AssetVariant): string | null {
  if (variant === 'source') return asset.sourceMime;
  if (variant === 'display') return asset.displayMime;
  return asset.thumbnailMime;
}

export function projectAssetVariantExt(asset: ProjectAsset, variant: AssetVariant): string {
  const mime = projectAssetVariantMime(asset, variant);
  return extForMime(mime, variant === 'source' ? 'bin' : 'jpg');
}

function assertOk<T extends { ok: true } | { ok: false; error: string }>(
  result: T,
): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(result.error);
  return result as Extract<T, { ok: true }>;
}

export const assetCacheService = {
  async getCachedPath(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
  ): Promise<CachedFile | null> {
    const res = assertOk(await platform.assetCache.getPath(projectId, assetId, variant, ext));
    if (!res.exists || res.sizeBytes == null || res.sizeBytes <= 0) return null;
    return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
  },

  async writeBytes(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    bytes: ArrayBuffer | Uint8Array,
  ): Promise<CachedFile> {
    const res = assertOk(
      await platform.assetCache.writeBytes(projectId, assetId, variant, ext, bytes),
    );
    return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
  },

  async copyFile(
    projectId: string,
    assetId: string,
    variant: AssetVariant,
    ext: string,
    sourcePath: string,
  ): Promise<CachedFile> {
    const res = assertOk(
      await platform.assetCache.copyFile(projectId, assetId, variant, ext, sourcePath),
    );
    return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
  },

  async uploadFile(input: {
    url: string;
    projectId: string;
    assetId: string;
    variant: AssetVariant;
    ext: string;
    contentType: string;
  }): Promise<number> {
    const res = assertOk(
      await platform.assetCache.uploadFile(
        input.url,
        input.projectId,
        input.assetId,
        input.variant,
        input.ext,
        input.contentType,
      ),
    );
    return res.sizeBytes;
  },

  async ensureCachedVariant(
    projectId: string,
    asset: ProjectAsset,
    variant: AssetVariant,
  ): Promise<CachedFile> {
    const ext = projectAssetVariantExt(asset, variant);
    const cached = await assetCacheService.getCachedPath(projectId, asset.id, variant, ext);
    if (cached) return cached;

    const signedUrl = await projectAssetService.getAssetUrl(projectId, asset.id, variant);
    const res = assertOk(
      await platform.assetCache.download(signedUrl, projectId, asset.id, variant, ext),
    );
    return { filePath: res.filePath, fileUrl: res.fileUrl, sizeBytes: res.sizeBytes };
  },

  async deleteAsset(projectId: string, assetId: string): Promise<void> {
    assertOk(await platform.assetCache.deleteAsset(projectId, assetId));
  },
};
