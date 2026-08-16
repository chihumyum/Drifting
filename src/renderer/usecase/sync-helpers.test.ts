import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendAuthoredDomainMutation: vi.fn(),
  appendAuthoredLifecycleRestoreInTransaction: vi.fn(),
  runAuthoredTransaction: vi.fn(),
}));

vi.mock('../sync/journal', () => ({
  appendAuthoredDomainMutation: mocks.appendAuthoredDomainMutation,
  runAuthoredTransaction: mocks.runAuthoredTransaction,
}));

vi.mock('./sync-lifecycle-restore', () => ({
  appendAuthoredLifecycleRestoreInTransaction:
    mocks.appendAuthoredLifecycleRestoreInTransaction,
  isRestorableSyncEntityKind: (kind: string) =>
    ['node', 'storyline', 'element', 'elementCategory'].includes(kind),
}));

import { withAtomicSyncTransaction } from './sync-helpers';

describe('withAtomicSyncTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAuthoredTransaction.mockImplementation(
      async (_projectId: string, _command: string, work: (context: object) => Promise<unknown>) =>
        work({ tx: { id: 'shared-tx' }, changes: { id: 'one-builder' }, origin: 'local' }),
    );
  });

  it('collects every domain write in one provider-neutral authored transaction', async () => {
    const result = await withAtomicSyncTransaction('project-1', async (tx, sync, changes) => {
      expect(tx).toEqual({ id: 'shared-tx' });
      expect(changes).toEqual({ id: 'one-builder' });
      await sync('node', 'update', 'node-1', 'project-1', { title: 'Updated' });
      await sync('comment', 'create', 'comment-1', 'project-1', { bodyJson: '{}' });
      return 'done';
    });

    expect(result).toBe('done');
    expect(mocks.runAuthoredTransaction).toHaveBeenCalledWith(
      'project-1',
      'domain.authored-write',
      expect.any(Function),
    );
    expect(mocks.appendAuthoredDomainMutation).toHaveBeenCalledTimes(2);
    expect(mocks.appendAuthoredDomainMutation).toHaveBeenNthCalledWith(
      1,
      { id: 'one-builder' },
      {
        entityType: 'node',
        mutationType: 'update',
        entityId: 'node-1',
        projectId: 'project-1',
        payload: { title: 'Updated' },
        parentId: undefined,
      },
    );
  });

  it('rejects a cross-project mutation before appending it', async () => {
    await expect(
      withAtomicSyncTransaction('project-1', async (_tx, sync) => {
        await sync('node', 'update', 'node-1', 'project-2', { title: 'Wrong' });
      }),
    ).rejects.toThrow('cannot record a mutation for project-2');
    expect(mocks.appendAuthoredDomainMutation).not.toHaveBeenCalled();
  });

  it('routes every reachable Trash restore through the full lifecycle capture', async () => {
    await withAtomicSyncTransaction('project-1', async (_tx, sync) => {
      await sync('node', 'restore', 'node-1', 'project-1');
      await sync('storyline', 'restore', 'storyline-1', 'project-1');
      await sync('element', 'restore', 'element-1', 'project-1');
      await sync('elementCategory', 'restore', 'category-1', 'project-1');
    });

    expect(mocks.appendAuthoredLifecycleRestoreInTransaction).toHaveBeenCalledTimes(4);
    expect(mocks.appendAuthoredLifecycleRestoreInTransaction).toHaveBeenNthCalledWith(
      1,
      { id: 'shared-tx' },
      { id: 'one-builder' },
      { projectId: 'project-1', entityType: 'node', entityId: 'node-1' },
    );
    expect(mocks.appendAuthoredLifecycleRestoreInTransaction).toHaveBeenNthCalledWith(
      4,
      { id: 'shared-tx' },
      { id: 'one-builder' },
      { projectId: 'project-1', entityType: 'elementCategory', entityId: 'category-1' },
    );
    expect(mocks.appendAuthoredDomainMutation).not.toHaveBeenCalled();
  });
});
