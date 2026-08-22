import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readBytes: vi.fn(),
  prepareImage: vi.fn(),
  createThumbnailVariant: vi.fn(),
  deleteImport: vi.fn(),
  copyFile: vi.fn(),
  writeBytes: vi.fn(),
  beginImport: vi.fn(),
  deleteAsset: vi.fn(),
  ensureBlobVerified: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: {
    material: {
      readBytes: mocks.readBytes,
      prepareImage: mocks.prepareImage,
      createThumbnailVariant: mocks.createThumbnailVariant,
      deleteImport: mocks.deleteImport,
    },
  },
}));

vi.mock('./asset-store.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./asset-store.service')>();
  return {
    extForMime: actual.extForMime,
    assetStoreService: {
      beginImport: mocks.beginImport,
      copyFile: mocks.copyFile,
      writeBytes: mocks.writeBytes,
      deleteAsset: mocks.deleteAsset,
    },
  };
});

vi.mock('../sync/assets/local-authored-blob', () => ({
  ensureLocalAuthoredAssetBlobVerified: mocks.ensureBlobVerified,
}));

import {
  prepareLocalProjectAsset,
  releasePickedMaterialImport,
} from './local-project-asset.service';

describe('local project asset preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginImport.mockResolvedValue(undefined);
    mocks.deleteAsset.mockResolvedValue(undefined);
    mocks.ensureBlobVerified.mockResolvedValue(undefined);
    mocks.readBytes.mockResolvedValue({
      ok: true,
      bytes: new TextEncoder().encode('abc').buffer,
    });
    mocks.copyFile.mockResolvedValue({
      filePath: '/app/asset/source.png',
      fileUrl: 'file:///app/asset/source.png',
      sizeBytes: 3,
    });
    mocks.writeBytes
      .mockResolvedValueOnce({
        filePath: '/app/asset/display.jpg',
        fileUrl: 'file:///app/asset/display.jpg',
        sizeBytes: 2,
      })
      .mockResolvedValueOnce({
        filePath: '/app/asset/thumbnail.jpg',
        fileUrl: 'file:///app/asset/thumbnail.jpg',
        sizeBytes: 1,
      });
    mocks.prepareImage.mockResolvedValue({
      ok: true,
      source: { mime: 'image/png', sizeBytes: 3, width: 120, height: 80 },
      display: {
        mime: 'image/jpeg',
        sizeBytes: 2,
        width: 120,
        height: 80,
        bytes: new Uint8Array([1, 2]).buffer,
      },
      thumbnail: {
        mime: 'image/jpeg',
        sizeBytes: 1,
        width: 64,
        height: 43,
        bytes: new Uint8Array([3]).buffer,
      },
    });
  });

  it('returns only immutable metadata for the app-owned source', async () => {
    const asset = await prepareLocalProjectAsset({
      projectId: 'project-1',
      kind: 'image',
      sourcePath: '/app/imports/reference.png',
      assetId: 'asset-1',
    });

    expect(asset).toMatchObject({
      id: 'asset-1',
      projectId: 'project-1',
      kind: 'image',
      sourceMime: 'image/png',
      sourceSizeBytes: 3,
      sourceSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    });
    expect(mocks.copyFile).toHaveBeenCalledWith(
      'project-1',
      'asset-1',
      'source',
      'png',
      '/app/imports/reference.png',
    );
    expect(mocks.beginImport).toHaveBeenCalledWith('project-1', 'asset-1');
    expect(mocks.ensureBlobVerified).toHaveBeenCalledWith(asset);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it.each([
    ['image/bmp', 'bmp'],
    ['image/tiff', 'tiff'],
    ['image/x-icon', 'ico'],
  ])('stores a supported %s source under its stable extension', async (mime, extension) => {
    mocks.prepareImage.mockResolvedValueOnce({
      ok: true,
      source: { mime, sizeBytes: 3, width: 120, height: 80 },
      display: {
        mime: 'image/jpeg',
        sizeBytes: 2,
        width: 120,
        height: 80,
        bytes: new Uint8Array([1, 2]).buffer,
      },
      thumbnail: {
        mime: 'image/jpeg',
        sizeBytes: 1,
        width: 64,
        height: 43,
        bytes: new Uint8Array([3]).buffer,
      },
    });

    const asset = await prepareLocalProjectAsset({
      projectId: 'project-1',
      kind: 'image',
      sourcePath: `/app/imports/reference.${extension}`,
      assetId: `asset-${extension}`,
    });

    expect(asset.sourceMime).toBe(mime);
    expect(mocks.copyFile).toHaveBeenCalledWith(
      'project-1',
      `asset-${extension}`,
      'source',
      extension,
      `/app/imports/reference.${extension}`,
    );
  });

  it('removes partial app-owned variants when preparation fails', async () => {
    mocks.prepareImage.mockResolvedValueOnce({
      ok: false,
      code: 'IMAGE_INVALID',
      codec: null,
      error: 'invalid image',
    });

    await expect(
      prepareLocalProjectAsset({
        projectId: 'project-1',
        kind: 'image',
        sourcePath: '/app/imports/broken.png',
        assetId: 'asset-broken',
      }),
    ).rejects.toThrow('invalid image');
    expect(mocks.deleteAsset).toHaveBeenCalledWith('project-1', 'asset-broken');
  });

  it('removes app-owned variants when native blob verification fails', async () => {
    mocks.ensureBlobVerified.mockRejectedValueOnce(new Error('blob verification failed'));

    await expect(
      prepareLocalProjectAsset({
        projectId: 'project-1',
        kind: 'image',
        sourcePath: '/app/imports/reference.png',
        assetId: 'asset-unverified',
      }),
    ).rejects.toThrow('blob verification failed');
    expect(mocks.deleteAsset).toHaveBeenCalledWith('project-1', 'asset-unverified');
  });

  it('waits for every sibling variant write before cleaning a failed import', async () => {
    let finishDisplay!: (value: { filePath: string; fileUrl: string; sizeBytes: number }) => void;
    mocks.copyFile.mockRejectedValueOnce(new Error('source write failed'));
    mocks.writeBytes.mockReset();
    mocks.writeBytes
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDisplay = resolve;
          }),
      )
      .mockResolvedValueOnce({
        filePath: '/app/asset/thumbnail.jpg',
        fileUrl: 'file:///app/asset/thumbnail.jpg',
        sizeBytes: 1,
      });

    const preparation = prepareLocalProjectAsset({
      projectId: 'project-1',
      kind: 'image',
      sourcePath: '/app/imports/reference.png',
      assetId: 'asset-race',
    });
    await vi.waitFor(() => expect(mocks.writeBytes).toHaveBeenCalled());
    expect(mocks.deleteAsset).not.toHaveBeenCalled();

    finishDisplay({
      filePath: '/app/asset/display.jpg',
      fileUrl: 'file:///app/asset/display.jpg',
      sizeBytes: 2,
    });
    await expect(preparation).rejects.toThrow('source write failed');
    expect(mocks.deleteAsset).toHaveBeenCalledWith('project-1', 'asset-race');
  });

  it('releases a picker import only through the native owned-file boundary', async () => {
    mocks.deleteImport.mockResolvedValueOnce({ ok: true });

    await releasePickedMaterialImport('/app/imports/reference.png');

    expect(mocks.deleteImport).toHaveBeenCalledWith('/app/imports/reference.png');
  });
});
