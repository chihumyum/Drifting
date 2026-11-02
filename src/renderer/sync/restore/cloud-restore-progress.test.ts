import { expect, it } from 'vitest';
import { declaredBlobBytes } from './cloud-restore';

it('totals each required blob once from the sizes its package declares', () => {
  const candidate = {
    package: {
      requiredBlobIds: ['sha256:a', 'sha256:b'],
      assets: [
        { blobId: 'sha256:a', sizeBytes: 300 },
        // Two assets may share one immutable blob; it downloads once.
        { blobId: 'sha256:a', sizeBytes: 300 },
        { blobId: 'sha256:b', sizeBytes: 50 },
        // Not required by this snapshot: never downloaded.
        { blobId: 'sha256:c', sizeBytes: 9_000 },
      ],
    },
  } as unknown as Parameters<typeof declaredBlobBytes>[0];
  expect(declaredBlobBytes(candidate)).toBe(350);
});
