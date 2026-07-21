import { describe, expect, it } from 'vitest';
import type { LibraryItem } from '../domain/library-item';
import {
  libraryItemServerPayload,
  overlayLibraryItemDeviceFields,
  stripLibraryItemDeviceFields,
} from './library-item-sync-boundary';

function libraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'library-1',
    projectId: 'project-1',
    title: 'Reference',
    kind: 'image',
    source: 'r2',
    uri: 'asset://asset-1',
    localPath: '/Users/this-device/reference.png',
    assetId: 'asset-1',
    mime: 'image/png',
    sizeBytes: 42,
    bodyJson: null,
    notesJson: null,
    thumbnailUri: 'https://cdn.example.test/thumbnail.png',
    orderKey: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('library item sync boundary', () => {
  it('never includes localPath in newly generated server payloads', () => {
    const payload = libraryItemServerPayload(libraryItem());

    expect(payload).not.toHaveProperty('localPath');
    expect(payload).toMatchObject({
      id: 'library-1',
      uri: 'asset://asset-1',
      assetId: 'asset-1',
      thumbnailUri: 'https://cdn.example.test/thumbnail.png',
    });
  });

  it('strips localPath from legacy outbox payloads without changing the input', () => {
    const legacyPayload = {
      id: 'library-1',
      localPath: '/Users/another-device/private.png',
      assetId: 'asset-1',
    };

    expect(stripLibraryItemDeviceFields(legacyPayload)).toEqual({
      id: 'library-1',
      assetId: 'asset-1',
    });
    expect(legacyPayload.localPath).toBe('/Users/another-device/private.png');
  });

  it('keeps an existing device path while retaining remote canonical asset fields', () => {
    const [row] = overlayLibraryItemDeviceFields(
      [
        {
          id: 'library-1',
          localPath: '/Users/remote-device/wrong.png',
          assetId: 'asset-new',
          uri: 'asset://asset-new',
          thumbnailUri: 'https://cdn.example.test/new-thumbnail.png',
        },
      ],
      [{ id: 'library-1', localPath: '/Users/this-device/right.png' }],
    );

    expect(row).toEqual({
      id: 'library-1',
      localPath: '/Users/this-device/right.png',
      assetId: 'asset-new',
      uri: 'asset://asset-new',
      thumbnailUri: 'https://cdn.example.test/new-thumbnail.png',
    });
  });

  it('sets localPath to null for first-seen cross-device rows and preserves an explicit local null', () => {
    const rows = overlayLibraryItemDeviceFields(
      [
        { id: 'first-seen', localPath: '/Users/remote-device/secret.pdf' },
        { id: 'known-without-file', localPath: '/Users/remote-device/other.pdf' },
      ],
      [{ id: 'known-without-file', localPath: null }],
    );

    expect(rows.map((row) => row.localPath)).toEqual([null, null]);
  });
});
