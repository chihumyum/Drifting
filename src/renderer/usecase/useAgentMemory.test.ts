import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMemory } from '../domain/agent-memory';

const mocks = vi.hoisted(() => ({
  rows: new Map<string, AgentMemory>(),
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  sync: vi.fn(),
}));

vi.mock('../sqlite-repo/agent-memory-repo', () => ({
  createAgentMemoryRepository: () => ({
    findById: async (id: string) => mocks.rows.get(id) ?? null,
    update: async (id: string, data: Record<string, unknown>) => {
      mocks.updates.push({ id, data });
      const current = mocks.rows.get(id);
      if (!current) return null;
      const next = { ...current, ...data } as AgentMemory;
      mocks.rows.set(id, next);
      return next;
    },
  }),
}));

vi.mock('./sync-helpers', () => ({
  withAtomicSyncTransaction: async (
    _projectId: string,
    work: (
      tx: Record<string, never>,
      sync: typeof mocks.sync,
    ) => Promise<unknown>,
  ) => work({}, mocks.sync),
}));

import { approvePendingMemory } from './useAgentMemory';

function memory(
  id: string,
  status: AgentMemory['status'],
  supersedesId: string | null = null,
): AgentMemory {
  return {
    id,
    projectId: 'project-1',
    kind: 'directive',
    body: id,
    targetKind: null,
    targetId: null,
    targetBlockId: null,
    source: 'agent',
    originRef: 'agent:session-1:turn-1:call-1',
    status,
    supersedesId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  };
}

beforeEach(() => {
  mocks.rows.clear();
  mocks.updates.length = 0;
  mocks.sync.mockReset();
});

describe('approvePendingMemory', () => {
  it('activates the proposal and retires its superseded memory atomically', async () => {
    mocks.rows.set('old', memory('old', 'active'));
    mocks.rows.set('new', memory('new', 'pending', 'old'));

    await expect(approvePendingMemory('project-1', 'new')).resolves.toMatchObject(
      { id: 'new', status: 'active' },
    );
    expect(mocks.updates.map(({ id, data }) => ({ id, status: data.status }))).toEqual([
      { id: 'new', status: 'active' },
      { id: 'old', status: 'dismissed' },
    ]);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it('is idempotent after both statuses have already settled', async () => {
    mocks.rows.set('old', memory('old', 'dismissed'));
    mocks.rows.set('new', memory('new', 'active', 'old'));

    await expect(approvePendingMemory('project-1', 'new')).resolves.toMatchObject(
      { id: 'new', status: 'active' },
    );
    expect(mocks.updates).toEqual([]);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('refuses to reactivate a dismissed proposal', async () => {
    mocks.rows.set('new', memory('new', 'dismissed'));

    await expect(
      approvePendingMemory('project-1', 'new'),
    ).rejects.toThrow('cannot be approved');
    expect(mocks.updates).toEqual([]);
  });
});
