import { describe, expect, it } from 'vitest';

import type { ProjectAsset } from '../domain/project-asset';
import { extForMime, projectAssetVariantExt } from './asset-store.service';

const ASSET: ProjectAsset = {
  id: 'asset-1',
  projectId: 'project-1',
  kind: 'image',
  sourceMime: 'image/png',
  sourceSizeBytes: 1,
  sourceSha256: '0'.repeat(64),
  width: 1,
  height: 1,
  createdAt: '2026-08-15T00:00:00.000Z',
};

describe('local asset MIME coordinates', () => {
  it.each([
    ['application/pdf', 'pdf'],
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/bmp', 'bmp'],
    ['image/x-icon', 'ico'],
    ['image/tiff', 'tiff'],
    ['image/heic', 'heic'],
    ['image/heif', 'heif'],
    ['image/avif', 'avif'],
  ])('maps %s to a stable source extension', (mime, extension) => {
    expect(extForMime(mime)).toBe(extension);
    expect(projectAssetVariantExt({ ...ASSET, sourceMime: mime }, 'source')).toBe(extension);
  });

  it('uses the same bounded fallback for import and later source lookup', () => {
    expect(extForMime('image/future-format')).toBe('bin');
    expect(
      projectAssetVariantExt({ ...ASSET, sourceMime: 'image/future-format' }, 'source'),
    ).toBe('bin');
    expect(projectAssetVariantExt(ASSET, 'display')).toBe('jpg');
    expect(projectAssetVariantExt(ASSET, 'thumbnail')).toBe('jpg');
  });
});
