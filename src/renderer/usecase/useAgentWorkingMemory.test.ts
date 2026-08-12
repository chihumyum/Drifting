import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentWorkingMemory } from '../domain/agent-working-memory';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  create: vi.fn(),
  updateCas: vi.fn(),
  sync: vi.fn(),
  withAtomicSyncTransaction: vi.fn(),
}));

vi.mock('../sqlite-repo/agent-working-memory-repo', () => ({
  createAgentWorkingMemoryRepository: () => ({
    find: mocks.find,
    create: mocks.create,
    updateCas: mocks.updateCas,
  }),
}));

vi.mock('./sync-helpers', () => ({
  withAtomicSyncTransaction: mocks.withAtomicSyncTransaction,
}));

import { clearAgentWorkingMemory, saveAgentWorkingMemory } from './useAgentWorkingMemory';

const existing: AgentWorkingMemory = {
  projectId: 'project-1',
  contentMd: '# Working Memory\n\n## Current\n\n- 验证同步。\n',
  revision: 3,
  approxTokens: 20,
  updatedBy: 'agent',
  lastCompactedAt: null,
  deletedAt: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
};

describe('Working Memory use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAtomicSyncTransaction.mockImplementation(
      async (_projectId: string, work: (tx: object, sync: typeof mocks.sync) => unknown) =>
        work({ id: 'tx' }, mocks.sync),
    );
  });

  it('persists a CAS update and its full singleton sync payload atomically', async () => {
    mocks.find.mockResolvedValue(existing);
    mocks.updateCas.mockImplementation(async (_revision, input) => ({
      ...existing,
      ...input,
    }));

    const result = await saveAgentWorkingMemory('project-1', {
      contentMd: `${existing.contentMd}\n## Recent\n\n- 完成了迁移验证。`,
      expectedRevision: 3,
      updatedBy: 'author',
    });

    expect(result.snapshot.revision).toBe(4);
    expect(mocks.updateCas).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ revision: 4, updatedBy: 'author', deletedAt: null }),
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      'agentWorkingMemory',
      'update',
      'project-1',
      'project-1',
      expect.objectContaining({ projectId: 'project-1', revision: 4 }),
    );
  });

  it('rejects a stale update before writing the row or outbox', async () => {
    mocks.find.mockResolvedValue(existing);

    await expect(
      saveAgentWorkingMemory('project-1', {
        contentMd: existing.contentMd,
        expectedRevision: 2,
        updatedBy: 'agent',
      }),
    ).rejects.toMatchObject({
      code: 'WORKING_MEMORY_REVISION_CONFLICT',
      expectedRevision: 2,
      actualRevision: 3,
    });
    expect(mocks.updateCas).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('clears through a revisioned tombstone without deleting long-term memory', async () => {
    mocks.find.mockResolvedValue(existing);
    mocks.updateCas.mockImplementation(async (_revision, input) => ({
      ...existing,
      ...input,
    }));

    const result = await clearAgentWorkingMemory('project-1', 3, 'author');

    expect(result).toMatchObject({ exists: false, revision: 4, contentMd: '' });
    expect(mocks.updateCas).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ revision: 4, contentMd: '', updatedBy: 'author' }),
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      'agentWorkingMemory',
      'update',
      'project-1',
      'project-1',
      expect.objectContaining({ revision: 4, deletedAt: expect.any(String) }),
    );
  });
});
