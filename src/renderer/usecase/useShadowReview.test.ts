import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookNode } from '../domain/book-node';
import type { Comment } from '../domain/comment';
import { commitShadowReview } from './useShadowReview';

const mocks = vi.hoisted(() => ({
  initDatabase: vi.fn(),
  getDb: vi.fn(),
  createCommentRepository: vi.fn(),
  createNodeRepository: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
  syncCommentCreate: vi.fn(),
  syncCommentDelete: vi.fn(),
  syncNodeUpdate: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  initDatabase: mocks.initDatabase,
  getDb: mocks.getDb,
}));

vi.mock('../sqlite-repo/comment-repo', () => ({
  createCommentRepository: mocks.createCommentRepository,
}));

vi.mock('../sqlite-repo/node-repo', () => ({
  createBookNodeSqliteRepository: mocks.createNodeRepository,
}));

vi.mock('../store/data-store', () => ({
  useDataStore: Object.assign(vi.fn(), {
    getState: mocks.getState,
    setState: mocks.setState,
  }),
}));

vi.mock('./sync-helpers', () => ({
  syncCommentCreate: mocks.syncCommentCreate,
  syncCommentDelete: mocks.syncCommentDelete,
  syncNodeUpdate: mocks.syncNodeUpdate,
}));

const projectId = 'project-1';
const chapterId = 'chapter-1';

function chapter(): BookNode {
  return {
    id: chapterId,
    projectId,
    kind: 'chapter',
    title: '第一章',
    summary: '',
    bookOrder: 0,
    narrativeOrder: null,
    driftGroupId: null,
    position: { x: 0, y: 0 },
    wordCount: 10,
    writingStatus: 'waiting_review',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function comment(id: string, source: Comment['source']): Comment {
  return {
    id,
    projectId,
    kind: 'note',
    targetKind: 'node',
    targetId: chapterId,
    targetBlockId: 'block-1',
    anchorJson: '{}',
    authorKind: source === 'shadow' ? 'ai' : 'user',
    authorId: null,
    authorName: source === 'shadow' ? 'Shadow' : null,
    bodyJson: '{}',
    status: 'open',
    priority: null,
    source,
    metadataJson: null,
    targetBlockIdsJson: '["block-1"]',
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

interface TestStoreState {
  bookNodes: BookNode[];
  comments: Comment[];
}

type TestStoreUpdater = (state: TestStoreState) => Partial<TestStoreState>;
type TransactionCallback = (tx: object) => Promise<unknown>;

describe('commitShadowReview', () => {
  let state: TestStoreState;
  let commentRepo: {
    findAll: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  let nodeRepo: { update: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      bookNodes: [chapter()],
      comments: [comment('manual-1', 'manual'), comment('shadow-old', 'shadow')],
    };
    commentRepo = {
      findAll: vi.fn().mockResolvedValue(state.comments),
      delete: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockImplementation(async (created: Comment) => created),
    };
    nodeRepo = { update: vi.fn().mockResolvedValue({ ...chapter(), writingStatus: 'draft' }) };
    mocks.initDatabase.mockResolvedValue(undefined);
    mocks.getState.mockImplementation(() => state);
    mocks.setState.mockImplementation((updater: TestStoreUpdater) => {
      Object.assign(state, updater(state));
    });
    mocks.createCommentRepository.mockReturnValue(commentRepo);
    mocks.createNodeRepository.mockReturnValue(nodeRepo);
  });

  it('publishes store state and enqueues sync only after the SQLite commit succeeds', async () => {
    const events: string[] = [];
    const tx = {};
    mocks.getDb.mockReturnValue({
      transaction: vi.fn(async (callback: TransactionCallback) => {
        events.push('transaction:start');
        const result = await callback(tx);
        events.push('transaction:commit');
        return result;
      }),
    });
    mocks.setState.mockImplementation((updater: TestStoreUpdater) => {
      events.push('store');
      Object.assign(state, updater(state));
    });
    mocks.syncCommentDelete.mockImplementation(() => events.push('sync:delete'));
    mocks.syncCommentCreate.mockImplementation(() => events.push('sync:create'));
    mocks.syncNodeUpdate.mockImplementation(() => events.push('sync:node'));

    const result = await commitShadowReview({
      projectId,
      userId: 'user-1',
      chapterId,
      status: 'draft',
      comments: [
        {
          bodyJson: '{"type":"doc"}',
          targetBlockId: 'block-2',
          targetBlockIds: ['block-2'],
          anchorJson: '{"blockSnapshots":[]}',
          metadataJson: '{"ruleId":"rule-1"}',
        },
      ],
    });

    expect(events).toEqual([
      'transaction:start',
      'transaction:commit',
      'store',
      'sync:delete',
      'sync:create',
      'sync:node',
    ]);
    expect(mocks.createCommentRepository).toHaveBeenCalledWith(projectId, tx);
    expect(mocks.createNodeRepository).toHaveBeenCalledWith(projectId, tx);
    expect(commentRepo.delete).toHaveBeenCalledWith('shadow-old');
    expect(commentRepo.create).toHaveBeenCalledOnce();
    expect(nodeRepo.update).toHaveBeenCalledWith(
      chapterId,
      expect.objectContaining({ writingStatus: 'draft' }),
    );
    expect(state.comments.map((entry) => entry.id)).toEqual(['manual-1', result.comments[0].id]);
    expect(state.bookNodes[0].writingStatus).toBe('draft');
    expect(result.replacedCommentIds).toEqual(['shadow-old']);
  });

  it('does not publish store state or enqueue sync when transaction commit fails', async () => {
    const originalState = structuredClone(state);
    mocks.getDb.mockReturnValue({
      transaction: vi.fn(async (callback: TransactionCallback) => {
        await callback({});
        throw new Error('commit failed');
      }),
    });

    await expect(
      commitShadowReview({
        projectId,
        userId: 'user-1',
        chapterId,
        status: 'finished',
        comments: [],
      }),
    ).rejects.toThrow('commit failed');

    expect(commentRepo.delete).toHaveBeenCalledWith('shadow-old');
    expect(nodeRepo.update).toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(mocks.syncCommentDelete).not.toHaveBeenCalled();
    expect(mocks.syncCommentCreate).not.toHaveBeenCalled();
    expect(mocks.syncNodeUpdate).not.toHaveBeenCalled();
    expect(state).toEqual(originalState);
  });
});
