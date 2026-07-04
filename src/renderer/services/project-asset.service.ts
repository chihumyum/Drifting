import { apiClient } from '../lib/axios-config';
import type { ProjectAsset } from '../domain/project-asset';

export type AssetVariant = 'display' | 'thumbnail';

export interface ElementPortraitUploadInput {
  elementId: string;
  sourceMime: string | null;
  sourceSizeBytes: number | null;
  displayMime: string;
  displaySizeBytes: number;
  thumbnailMime: string;
  thumbnailSizeBytes: number;
  width: number | null;
  height: number | null;
}

export interface ElementPortraitUploadResponse {
  asset: ProjectAsset;
  uploads: {
    display: { url: string; contentType: string; objectKey: string };
    thumbnail: { url: string; contentType: string; objectKey: string };
  };
}

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
    kind: (row.kind === 'image' ? row.kind : 'image') as ProjectAsset['kind'],
    role: (row.role === 'element_portrait' ? row.role : 'element_portrait') as ProjectAsset['role'],
    ownerKind: (row.ownerKind === 'element'
      ? row.ownerKind
      : 'element') as ProjectAsset['ownerKind'],
    ownerId: String(row.ownerId ?? ''),
    status: (row.status === 'ready' || row.status === 'failed'
      ? row.status
      : 'pending') as ProjectAsset['status'],
    displayObjectKey: String(row.displayObjectKey ?? ''),
    thumbnailObjectKey: String(row.thumbnailObjectKey ?? ''),
    sourceMime: typeof row.sourceMime === 'string' ? row.sourceMime : null,
    displayMime: String(row.displayMime ?? ''),
    thumbnailMime: String(row.thumbnailMime ?? 'image/jpeg'),
    sourceSizeBytes: nullableNumber(row.sourceSizeBytes),
    displaySizeBytes: nullableNumber(row.displaySizeBytes),
    thumbnailSizeBytes: nullableNumber(row.thumbnailSizeBytes),
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
      uploads: ElementPortraitUploadResponse['uploads'];
    }>(`/api/projects/${projectId}/assets/element-portrait-upload`, input);
    return { asset: normalizeProjectAsset(data.asset), uploads: data.uploads };
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
    for (const variant of ['display', 'thumbnail'] as const) {
      urlCache.delete(`${projectId}:${assetId}:${variant}`);
    }
  },
};
