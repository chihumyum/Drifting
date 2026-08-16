import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../lib/db';
import { reconcileNativeSyncObjects } from './local-object-gc';

describe('native SyncEngine local-object reconciliation', () => {
  it('passes the deduplicated durable SQLite inventory to the native confined GC', async () => {
    const from = vi.fn(async () => [
      { storageRef: 'syncobj:z-retained' },
      { storageRef: 'syncobj:a-retained' },
      { storageRef: 'syncobj:z-retained' },
    ]);
    const db = {
      select: vi.fn(() => ({ from })),
    } as unknown as DbClient;
    const gcOrphans = vi.fn(async () => ({
      removedObjects: 2,
      removedTemporaryFiles: 1,
    }));

    await expect(
      reconcileNativeSyncObjects({
        db,
        native: { gcOrphans },
        orphanAgeMs: 1234,
      }),
    ).resolves.toEqual({ removedObjects: 2, removedTemporaryFiles: 1 });
    expect(gcOrphans).toHaveBeenCalledWith({
      retainedSourceRefs: ['syncobj:a-retained', 'syncobj:z-retained'],
      olderThanMs: 1234,
    });
  });
});
