import { describe, expect, it } from 'vitest';

import type { ProjectAsset } from '../../domain/project-asset';
import { SyncChangeBuilder } from './change-builder';
import {
  appendProjectAssetBindMutation,
  appendProjectAssetUnbindMutation,
} from './asset-mutation';

const ASSET: ProjectAsset = {
  id: 'asset-1',
  projectId: 'project-1',
  kind: 'image',
  sourceMime: 'image/png',
  sourceSizeBytes: 3,
  sourceSha256: 'a'.repeat(64),
  width: 10,
  height: 20,
  createdAt: '2026-08-15T00:00:00.000Z',
};

describe('project asset journal mutations', () => {
  it('records immutable metadata, content-addressed blob and owner binding', async () => {
    const changes = new SyncChangeBuilder();
    expect(
      appendProjectAssetBindMutation(changes, 'project-1', ASSET, {
        kind: 'library-item',
        id: 'library-1',
      }),
    ).toBe(`sha256:${'a'.repeat(64)}`);

    const finalized = await changes.finalize();
    expect(finalized.mutations[0]?.mutation).toMatchObject({
      action: 'asset.bind',
      target: { family: 'asset', kind: 'project-asset', id: 'asset-1' },
      payload: {
        blobId: `sha256:${'a'.repeat(64)}`,
        sourceSha256: `sha256:${'a'.repeat(64)}`,
        sourceMime: 'image/png',
        sourceSizeBytes: 3,
        owner: { kind: 'library-item', id: 'library-1' },
      },
    });
  });

  it('records owner removal without requesting remote blob deletion', async () => {
    const changes = new SyncChangeBuilder();
    appendProjectAssetUnbindMutation(changes, 'asset-1', {
      kind: 'element-portrait',
      id: 'element-1',
    });

    const mutation = (await changes.finalize()).mutations[0]?.mutation;
    expect(mutation).toMatchObject({
      action: 'asset.unbind',
      payload: { owner: { kind: 'element-portrait', id: 'element-1' } },
    });
    expect(JSON.stringify(mutation)).not.toMatch(/delete|gc|provider/u);
  });

  it('rejects cross-project metadata and malformed source hashes', () => {
    const changes = new SyncChangeBuilder();
    expect(() =>
      appendProjectAssetBindMutation(changes, 'project-2', ASSET, {
        kind: 'library-item',
        id: 'library-1',
      }),
    ).toThrow(/does not belong/u);
    expect(() =>
      appendProjectAssetBindMutation(
        changes,
        'project-1',
        { ...ASSET, sourceSha256: 'not-a-hash' },
        { kind: 'library-item', id: 'library-1' },
      ),
    ).toThrow(/sourceSha256/u);
  });
});
