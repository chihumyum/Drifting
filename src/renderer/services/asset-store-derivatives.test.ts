import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectAsset } from '../domain/project-asset';

const mocks = vi.hoisted(() => ({
  files: new Set<string>(),
  getPath: vi.fn(),
  writeBytes: vi.fn(),
  prepareImage: vi.fn(),
  createThumbnailVariant: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: {
    assetStore: { getPath: mocks.getPath, writeBytes: mocks.writeBytes },
    material: {
      prepareImage: mocks.prepareImage,
      createThumbnailVariant: mocks.createThumbnailVariant,
    },
  },
}));

import { assetStoreService } from './asset-store.service';

const IMAGE: ProjectAsset = {
  id: 'asset-1',
  projectId: 'project-1',
  kind: 'image',
  sourceMime: 'image/png',
  sourceSizeBytes: 4,
  sourceSha256: '0'.repeat(64),
  width: 2,
  height: 2,
  createdAt: '2026-11-03T00:00:00.000Z',
};
const PDF: ProjectAsset = { ...IMAGE, id: 'asset-2', kind: 'pdf', sourceMime: 'application/pdf' };

const bytes = (length: number) => new Uint8Array(length).buffer;
const file = (assetId: string, variant: string, ext: string) => `/assets/project-1/${assetId}/${variant}.${ext}`;

describe('rebuildable asset derivatives', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.files.clear();
    mocks.getPath.mockImplementation(async (_projectId: string, assetId: string, variant: string, ext: string) => {
      const filePath = file(assetId, variant, ext);
      const exists = mocks.files.has(filePath);
      return { ok: true, filePath, fileUrl: `asset://${filePath}`, exists, sizeBytes: exists ? 4 : null };
    });
    mocks.writeBytes.mockImplementation(async (_projectId: string, assetId: string, variant: string, ext: string) => {
      const filePath = file(assetId, variant, ext);
      mocks.files.add(filePath);
      return { ok: true, filePath, fileUrl: `asset://${filePath}`, sizeBytes: 4 };
    });
    mocks.prepareImage.mockResolvedValue({
      ok: true,
      display: { bytes: bytes(3) },
      thumbnail: { bytes: bytes(2) },
    });
    mocks.createThumbnailVariant.mockResolvedValue({ ok: true, bytes: bytes(2) });
  });

  it('rebuilds a missing image display from the source bytes', async () => {
    mocks.files.add(file(IMAGE.id, 'source', 'png'));

    await expect(assetStoreService.requireVariant('project-1', IMAGE, 'display')).resolves.toMatchObject({
      filePath: file(IMAGE.id, 'display', 'jpg'),
    });
    expect(mocks.prepareImage).toHaveBeenCalledWith(file(IMAGE.id, 'source', 'png'));
    expect(mocks.files).toContain(file(IMAGE.id, 'thumbnail', 'jpg'));
  });

  it('shares one rebuild between concurrent reads of the same asset', async () => {
    mocks.files.add(file(IMAGE.id, 'source', 'png'));

    await Promise.all([
      assetStoreService.requireVariant('project-1', IMAGE, 'display'),
      assetStoreService.requireVariant('project-1', IMAGE, 'thumbnail'),
    ]);
    expect(mocks.prepareImage).toHaveBeenCalledTimes(1);
  });

  it('rebuilds only the thumbnail of a PDF', async () => {
    mocks.files.add(file(PDF.id, 'source', 'pdf'));

    await expect(assetStoreService.requireVariant('project-1', PDF, 'thumbnail')).resolves.toMatchObject({
      filePath: file(PDF.id, 'thumbnail', 'jpg'),
    });
    expect(mocks.createThumbnailVariant).toHaveBeenCalledWith(file(PDF.id, 'source', 'pdf'), 512, 72);
    await expect(assetStoreService.requireVariant('project-1', PDF, 'display')).rejects.toThrow(
      'missing its display variant',
    );
    expect(mocks.createThumbnailVariant).toHaveBeenCalledTimes(1);
  });

  it('reports a missing source without rebuilding anything', async () => {
    await expect(assetStoreService.requireVariant('project-1', IMAGE, 'source')).rejects.toThrow(
      'missing its source variant',
    );
    await expect(assetStoreService.requireVariant('project-1', IMAGE, 'display')).rejects.toThrow(
      'missing its display variant',
    );
    expect(mocks.prepareImage).not.toHaveBeenCalled();
    expect(mocks.writeBytes).not.toHaveBeenCalled();
  });

  it('writes nothing when the asset is deleted while its derivatives are prepared', async () => {
    mocks.files.add(file(IMAGE.id, 'source', 'png'));
    mocks.prepareImage.mockImplementation(async () => {
      mocks.files.clear();
      return { ok: true, display: { bytes: bytes(3) }, thumbnail: { bytes: bytes(2) } };
    });

    await expect(assetStoreService.requireVariant('project-1', IMAGE, 'display')).rejects.toThrow(
      'missing its display variant',
    );
    expect(mocks.writeBytes).not.toHaveBeenCalled();
  });

  it('surfaces a source that cannot be decoded', async () => {
    mocks.files.add(file(IMAGE.id, 'source', 'png'));
    mocks.prepareImage.mockResolvedValue({ ok: false, error: 'unsupported image' });

    await expect(assetStoreService.requireVariant('project-1', IMAGE, 'display')).rejects.toThrow(
      'unsupported image',
    );
  });
});
