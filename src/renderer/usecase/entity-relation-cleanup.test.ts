import { describe, expect, it, vi } from 'vitest';
import type { DbTransaction } from '../lib/db';
import type { AtomicSyncWriter } from './sync-helpers';
import {
  deleteEntityRelationsInTransaction,
  withoutRelationsForEntity,
} from './entity-relation-cleanup';

describe('withoutRelationsForEntity', () => {
  it('removes both incoming and outgoing relations only in the active project', () => {
    const relations = [
      {
        id: 'outgoing',
        projectId: 'project-1',
        fromKind: 'element',
        fromId: 'element-1',
        toKind: 'node',
        toId: 'node-1',
      },
      {
        id: 'incoming',
        projectId: 'project-1',
        fromKind: 'node',
        fromId: 'node-2',
        toKind: 'element',
        toId: 'element-1',
      },
      {
        id: 'other-project',
        projectId: 'project-2',
        fromKind: 'element',
        fromId: 'element-1',
        toKind: 'node',
        toId: 'node-1',
      },
    ];

    expect(
      withoutRelationsForEntity(relations, 'project-1', 'element', 'element-1').map(
        (relation) => relation.id,
      ),
    ).toEqual(['other-project']);
  });
});

describe('deleteEntityRelationsInTransaction', () => {
  it('deletes all matching rows and writes one outbox mutation per relation', async () => {
    const whereSelect = vi.fn().mockResolvedValue([{ id: 'relation-1' }, { id: 'relation-2' }]);
    const whereDelete = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: whereSelect })),
      })),
      delete: vi.fn(() => ({ where: whereDelete })),
    } as unknown as DbTransaction;
    const sync = vi.fn().mockResolvedValue(undefined) as unknown as AtomicSyncWriter;

    await expect(
      deleteEntityRelationsInTransaction(tx, sync, 'project-1', 'storyline', 'storyline-1'),
    ).resolves.toEqual(['relation-1', 'relation-2']);

    expect(whereDelete).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenNthCalledWith(
      1,
      'entityRelation',
      'delete',
      'relation-1',
      'project-1',
    );
    expect(sync).toHaveBeenNthCalledWith(
      2,
      'entityRelation',
      'delete',
      'relation-2',
      'project-1',
    );
  });

  it('does not issue a delete or outbox write when no relation matches', async () => {
    const deleteRows = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
      })),
      delete: deleteRows,
    } as unknown as DbTransaction;
    const sync = vi.fn().mockResolvedValue(undefined) as unknown as AtomicSyncWriter;

    await expect(
      deleteEntityRelationsInTransaction(tx, sync, 'project-1', 'node', 'node-1'),
    ).resolves.toEqual([]);
    expect(deleteRows).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});
