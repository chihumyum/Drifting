import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  persistSyncMutationInTransaction: vi.fn(),
  notifySyncMutationCommitted: vi.fn(),
  bumpLocalMutationGeneration: vi.fn(),
  trackAtomicSyncTransaction: vi.fn(),
}));

vi.mock('../lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('../services/entity-sync.service', () => ({
  persistSyncMutationInTransaction: mocks.persistSyncMutationInTransaction,
  notifySyncMutationCommitted: mocks.notifySyncMutationCommitted,
}));
vi.mock('../services/local-mutation-generation', () => ({
  localMutationGeneration: {
    bump: mocks.bumpLocalMutationGeneration,
  },
}));
vi.mock('../services/atomic-sync-transaction-tracker', () => ({
  trackAtomicSyncTransaction: mocks.trackAtomicSyncTransaction,
}));

import { withAtomicSyncTransaction } from './sync-helpers';

describe('withAtomicSyncTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistSyncMutationInTransaction.mockResolvedValue(true);
    mocks.trackAtomicSyncTransaction.mockImplementation((operation) => operation);
  });

  it('uses the domain write transaction for the outbox row and notifies after commit', async () => {
    const events: string[] = [];
    const tx = { id: 'shared-transaction' };
    mocks.getDb.mockReturnValue({
      transaction: vi.fn(async (callback: (executor: object) => Promise<string>) => {
        events.push('transaction:start');
        const result = await callback(tx);
        events.push('transaction:commit');
        return result;
      }),
    });
    mocks.persistSyncMutationInTransaction.mockImplementation(async (executor) => {
      events.push('outbox:write');
      expect(executor).toBe(tx);
      return true;
    });
    mocks.notifySyncMutationCommitted.mockImplementation(() => {
      events.push('sync:notify');
    });
    mocks.bumpLocalMutationGeneration.mockImplementation(() => {
      events.push('generation:bump');
    });

    const result = await withAtomicSyncTransaction('project-1', async (executor, sync) => {
      expect(executor).toBe(tx);
      events.push('entity:write');
      await sync('node', 'update', 'node-1', 'project-1', { title: 'Updated' });
      return 'done';
    });

    expect(result).toBe('done');
    expect(events).toEqual([
      'generation:bump',
      'transaction:start',
      'entity:write',
      'outbox:write',
      'transaction:commit',
      'sync:notify',
    ]);
    expect(mocks.bumpLocalMutationGeneration).toHaveBeenCalledWith('project-1');
    expect(mocks.persistSyncMutationInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        entityType: 'node',
        mutationType: 'update',
        entityId: 'node-1',
        projectId: 'project-1',
        payload: { title: 'Updated' },
      }),
    );
  });

  it('does not notify the network runtime when the transaction fails', async () => {
    const tx = { id: 'rolled-back-transaction' };
    mocks.getDb.mockReturnValue({
      transaction: vi.fn(async (callback: (executor: object) => Promise<void>) => {
        await callback(tx);
        throw new Error('commit failed');
      }),
    });

    await expect(
      withAtomicSyncTransaction('project-1', async (_executor, sync) => {
        await sync('nodeContent', 'update', 'node-1', 'project-1', {
          contentJson: '{}',
        });
      }),
    ).rejects.toThrow('commit failed');

    expect(mocks.persistSyncMutationInTransaction).toHaveBeenCalledOnce();
    expect(mocks.notifySyncMutationCommitted).not.toHaveBeenCalled();
  });

  it('does not notify when sync persistence is disabled', async () => {
    const tx = { id: 'local-only-transaction' };
    mocks.getDb.mockReturnValue({
      transaction: vi.fn(async (callback: (executor: object) => Promise<void>) => callback(tx)),
    });
    mocks.persistSyncMutationInTransaction.mockResolvedValue(false);

    await withAtomicSyncTransaction('project-1', async (_executor, sync) => {
      await sync('element', 'create', 'element-1', 'project-1', { name: 'Alice' });
    });

    expect(mocks.notifySyncMutationCommitted).not.toHaveBeenCalled();
  });

  it('rejects cross-project mutations before writing the outbox', async () => {
    const tx = { id: 'project-scoped-transaction' };
    mocks.getDb.mockReturnValue({
      transaction: vi.fn(async (callback: (executor: object) => Promise<void>) => callback(tx)),
    });

    await expect(
      withAtomicSyncTransaction('project-1', async (_executor, sync) => {
        await sync('node', 'update', 'node-1', 'project-2', { title: 'Wrong project' });
      }),
    ).rejects.toThrow('cannot persist a mutation for project-2');

    expect(mocks.persistSyncMutationInTransaction).not.toHaveBeenCalled();
    expect(mocks.notifySyncMutationCommitted).not.toHaveBeenCalled();
  });
});
