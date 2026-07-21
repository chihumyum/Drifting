import { apiClient } from '../lib/axios-config';
import type { ProjectAsset } from '../domain/project-asset';

export type AssetVariant = 'source' | 'display' | 'thumbnail';

export interface ElementPortraitUploadInput {
  uploadId: string;
  elementId: string;
  sourceMime: string;
  sourceSizeBytes: number;
  displayMime: string;
  displaySizeBytes: number;
  thumbnailMime: string;
  thumbnailSizeBytes: number;
  width: number | null;
  height: number | null;
}

type ElementPortraitUploads = {
  source: { url: string; contentType: string; objectKey: string };
  display: { url: string; contentType: string; objectKey: string };
  thumbnail: { url: string; contentType: string; objectKey: string };
};

export type ElementPortraitUploadResponse =
  | {
      asset: ProjectAsset;
      uploadState: 'pending';
      uploads: ElementPortraitUploads;
    }
  | {
      asset: ProjectAsset;
      uploadState: 'ready';
      uploads: null;
    };

export interface LibraryMaterialUploadInput {
  uploadId: string;
  libraryItemId: string;
  kind: 'image' | 'pdf';
  sourceMime: string;
  sourceSizeBytes: number;
  sourceSha256?: string | null;
  displayMime?: string | null;
  displaySizeBytes?: number | null;
  thumbnailMime: string;
  thumbnailSizeBytes: number;
  width?: number | null;
  height?: number | null;
}

type LibraryMaterialUploads = {
  source: { url: string; contentType: string; objectKey: string };
  display: { url: string; contentType: string; objectKey: string } | null;
  thumbnail: { url: string; contentType: string; objectKey: string };
};

export type LibraryMaterialUploadResponse =
  | {
      asset: ProjectAsset;
      uploadState: 'pending';
      uploads: LibraryMaterialUploads;
    }
  | {
      asset: ProjectAsset;
      uploadState: 'ready';
      uploads: null;
    };

function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  return new Date().toISOString();
}

function nullableDateText(value: unknown): string | null {
  if (value == null) return null;
  return dateText(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeProjectAsset(row: Record<string, unknown>): ProjectAsset {
  return {
    id: String(row.id ?? ''),
    projectId: String(row.projectId ?? ''),
    kind: (row.kind === 'pdf' ? 'pdf' : 'image') as ProjectAsset['kind'],
    role: (row.role === 'library_material'
      ? 'library_material'
      : 'element_portrait') as ProjectAsset['role'],
    ownerKind: (row.ownerKind === 'library_item'
      ? 'library_item'
      : 'element') as ProjectAsset['ownerKind'],
    ownerId: String(row.ownerId ?? ''),
    status: (row.status === 'ready' || row.status === 'failed'
      ? row.status
      : 'pending') as ProjectAsset['status'],
    sourceObjectKey: typeof row.sourceObjectKey === 'string' ? row.sourceObjectKey : null,
    displayObjectKey: typeof row.displayObjectKey === 'string' ? row.displayObjectKey : null,
    thumbnailObjectKey: typeof row.thumbnailObjectKey === 'string' ? row.thumbnailObjectKey : null,
    sourceMime: typeof row.sourceMime === 'string' ? row.sourceMime : null,
    displayMime: typeof row.displayMime === 'string' ? row.displayMime : null,
    thumbnailMime: typeof row.thumbnailMime === 'string' ? row.thumbnailMime : null,
    sourceSizeBytes: nullableNumber(row.sourceSizeBytes),
    displaySizeBytes: nullableNumber(row.displaySizeBytes),
    thumbnailSizeBytes: nullableNumber(row.thumbnailSizeBytes),
    sourceSha256: typeof row.sourceSha256 === 'string' ? row.sourceSha256 : null,
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    completedAt: nullableDateText(row.completedAt),
    deletedAt: nullableDateText(row.deletedAt),
    createdAt: dateText(row.createdAt),
    updatedAt: dateText(row.updatedAt),
  };
}

const urlCache = new Map<string, { url: string; expiresAt: number }>();

export const projectAssetService = {
  async createElementPortraitUpload(
    projectId: string,
    input: ElementPortraitUploadInput,
  ): Promise<ElementPortraitUploadResponse> {
    const { data } = await apiClient.post<{
      asset: Record<string, unknown>;
      uploadState: 'pending' | 'ready';
      uploads: ElementPortraitUploads | null;
    }>(`/api/projects/${projectId}/assets/element-portrait-upload`, input);
    const asset = normalizeProjectAsset(data.asset);
    if (data.uploadState === 'ready') {
      if (data.uploads !== null || asset.status !== 'ready') {
        throw new Error('Ready portrait upload response is inconsistent');
      }
      return { asset, uploadState: 'ready', uploads: null };
    }
    if (data.uploadState !== 'pending' || !data.uploads || asset.status !== 'pending') {
      throw new Error('Pending portrait upload response is inconsistent');
    }
    return { asset, uploadState: 'pending', uploads: data.uploads };
  },

  async createLibraryMaterialUpload(
    projectId: string,
    input: LibraryMaterialUploadInput,
  ): Promise<LibraryMaterialUploadResponse> {
    const { data } = await apiClient.post<{
      asset: Record<string, unknown>;
      uploadState: 'pending' | 'ready';
      uploads: LibraryMaterialUploads | null;
    }>(`/api/projects/${projectId}/assets/library-material-upload`, input);
    const asset = normalizeProjectAsset(data.asset);
    if (data.uploadState === 'ready') {
      if (data.uploads !== null || asset.status !== 'ready') {
        throw new Error('Ready material upload response is inconsistent');
      }
      return { asset, uploadState: 'ready', uploads: null };
    }
    if (data.uploadState !== 'pending' || !data.uploads || asset.status !== 'pending') {
      throw new Error('Pending material upload response is inconsistent');
    }
    return { asset, uploadState: 'pending', uploads: data.uploads };
  },

  async uploadToSignedUrl(url: string, bytes: ArrayBuffer | Uint8Array, contentType: string) {
    let body: ArrayBuffer;
    if (bytes instanceof ArrayBuffer) {
      body = bytes;
    } else {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      body = copy.buffer as ArrayBuffer;
    }
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    });
    if (!response.ok) {
      throw new Error(`Upload failed: HTTP ${response.status}`);
    }
  },

  async completeUpload(projectId: string, assetId: string): Promise<ProjectAsset> {
    const { data } = await apiClient.post<{ asset: Record<string, unknown> }>(
      `/api/projects/${projectId}/assets/${assetId}/complete`,
    );
    return normalizeProjectAsset(data.asset);
  },

  async getAssetUrl(projectId: string, assetId: string, variant: AssetVariant): Promise<string> {
    const key = `${projectId}:${assetId}:${variant}`;
    const cached = urlCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now + 60_000) return cached.url;

    const { data } = await apiClient.get<{ url: string; expiresIn: number }>(
      `/api/projects/${projectId}/assets/${assetId}/url`,
      { params: { variant } },
    );
    urlCache.set(key, {
      url: data.url,
      expiresAt: now + Math.max(1, data.expiresIn - 60) * 1000,
    });
    return data.url;
  },

  async deleteAsset(projectId: string, assetId: string): Promise<void> {
    await apiClient.delete(`/api/projects/${projectId}/assets/${assetId}`);
    for (const variant of ['source', 'display', 'thumbnail'] as const) {
      urlCache.delete(`${projectId}:${assetId}:${variant}`);
    }
  },
};
