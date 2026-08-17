import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nodeFindById: vi.fn(),
  nodeUpdate: vi.fn(),
  getLinks: vi.fn(),
  setNodeStorylines: vi.fn(),
  appendMembership: vi.fn(),
  atomic: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('../sqlite-repo/node-repo', () => ({
  createBookNodeSqliteRepository: () => ({
    findById: mocks.nodeFindById,
    update: mocks.nodeUpdate,
  }),
}));

vi.mock('../sqlite-repo/node-storyline-link-repo', () => ({
  createNodeStorylineLinkRepository: () => ({
    getStorylineLinksByNodeIds: mocks.getLinks,
    setNodeStorylines: mocks.setNodeStorylines,
  }),
}));

vi.mock('../sync/journal/storyline-membership', () => ({
  appendAuthoredNodeStorylineProjectionInTransaction: mocks.appendMembership,
}));

vi.mock('./sync-helpers', () => ({
  withAtomicSyncTransaction: mocks.atomic,
}));

import {
  persistChapterTimelineMove,
  resolveChapterTimelineMembership,
} from './chapter-timeline-move';

describe('chapter timeline move', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.atomic.mockImplementation(async (_projectId, work) =>
      work({ id: 'one-tx' }, mocks.sync, { id: 'one-builder' }),
    );
    mocks.nodeFindById.mockResolvedValue({ id: 'chapter-1', kind: 'chapter' });
    mocks.nodeUpdate.mockResolvedValue({
      id: 'chapter-1',
      kind: 'chapter',
      bookOrder: 12.375,
      narrativeOrder: null,
    });
    mocks.getLinks.mockResolvedValue([
      { nodeId: 'chapter-1', storylineId: 'storyline-a', isPrimary: true },
      { nodeId: 'chapter-1', storylineId: 'storyline-c', isPrimary: false },
    ]);
  });

  it('preserves secondaries while replacing the primary lane', () => {
    expect(
      resolveChapterTimelineMembership(
        {
          membershipIds: ['storyline-a', 'storyline-c'],
          primaryStorylineId: 'storyline-a',
        },
        'storyline-b',
      ),
    ).toEqual({
      membershipIds: ['storyline-c', 'storyline-b'],
      primaryStorylineId: 'storyline-b',
    });
  });

  it('writes coordinate, membership and primary through one authored transaction', async () => {
    const result = await persistChapterTimelineMove({
      projectId: 'project-1',
      nodeId: 'chapter-1',
      orderField: 'bookOrder',
      order: 12.375,
      targetStorylineId: 'storyline-b',
      updatedAt: '2026-08-18T00:00:00.000Z',
    });

    expect(mocks.atomic).toHaveBeenCalledTimes(1);
    expect(mocks.nodeUpdate).toHaveBeenCalledWith('chapter-1', {
      bookOrder: 12.375,
      updatedAt: '2026-08-18T00:00:00.000Z',
    });
    expect(mocks.setNodeStorylines).toHaveBeenCalledWith(
      'chapter-1',
      ['storyline-c', 'storyline-b'],
      { primaryStorylineId: 'storyline-b' },
    );
    expect(mocks.appendMembership).toHaveBeenCalledWith(
      { id: 'one-tx' },
      { id: 'one-builder' },
      { projectId: 'project-1', nodeId: 'chapter-1' },
    );
    expect(mocks.sync).toHaveBeenCalledWith(
      'node',
      'update',
      'chapter-1',
      'project-1',
      { bookOrder: 12.375 },
    );
    expect(result.membership).toEqual({
      membershipIds: ['storyline-c', 'storyline-b'],
      primaryStorylineId: 'storyline-b',
    });
  });

  it('still records the coordinate mutation when lane membership is unchanged', async () => {
    await persistChapterTimelineMove({
      projectId: 'project-1',
      nodeId: 'chapter-1',
      orderField: 'narrativeOrder',
      order: 8.25,
      updatedAt: '2026-08-18T00:00:00.000Z',
    });

    expect(mocks.setNodeStorylines).not.toHaveBeenCalled();
    expect(mocks.appendMembership).not.toHaveBeenCalled();
    expect(mocks.sync).toHaveBeenCalledWith(
      'node',
      'update',
      'chapter-1',
      'project-1',
      { narrativeOrder: 8.25 },
    );
  });
});
