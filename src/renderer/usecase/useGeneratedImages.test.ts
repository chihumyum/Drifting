import { describe, expect, it } from 'vitest';
import type { BookElement } from '../domain/book-element';
import type { LibraryItem } from '../domain/library-item';
import type { ProjectAsset } from '../domain/project-asset';
import { portraitToPreserve } from './useGeneratedImages';

const asset = (id: string, sha: string): ProjectAsset => ({
  id,
  projectId: 'project-1',
  kind: 'image',
  sourceMime: 'image/png',
  sourceSizeBytes: 1,
  sourceSha256: sha.repeat(64),
  width: 1,
  height: 1,
  createdAt: 'now',
});
const element = (portraitAssetId: string | null) =>
  ({ id: 'element-1', projectId: 'project-1', name: 'A', portraitAssetId }) as BookElement;
const material = (assetId: string) => ({ id: `item-${assetId}`, kind: 'image', assetId }) as LibraryItem;

describe('portraitToPreserve', () => {
  it('copies a portrait that no material holds yet', () => {
    const portrait = asset('portrait', 'a');
    expect(
      portraitToPreserve(
        { bookElements: [element('portrait')], projectAssets: [portrait], libraryItems: [] },
        'element-1',
      ),
    ).toBe(portrait);
  });

  it('skips a portrait whose bytes are already a material, and elements without one', () => {
    const state = {
      bookElements: [element('portrait')],
      projectAssets: [asset('portrait', 'a'), asset('kept', 'a')],
      libraryItems: [material('kept')],
    };
    expect(portraitToPreserve(state, 'element-1')).toBeNull();
    expect(
      portraitToPreserve({ bookElements: [element(null)], projectAssets: [], libraryItems: [] }, 'element-1'),
    ).toBeNull();
  });
});
