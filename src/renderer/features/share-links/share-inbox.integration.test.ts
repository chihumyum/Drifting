import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../lib/db';
import { events } from '../../lib/events';
import { CommentTable } from '../../schema/drizzle';
import {
  createWorkspaceProjectionFixture,
  WORKSPACE_TEST_INPUT as INPUT,
  WORKSPACE_TEST_NOW as NOW,
} from '../../services/workspace-projection.test-support';
import type { ShareInbox, ShareInboxComment } from './share-link-api';

const mocks = vi.hoisted(() => ({
  sync: [] as unknown[][],
  acknowledged: [] as [string[], string[]][],
  statuses: [] as unknown[],
}));

// The journal is covered by its own suites; this records what the import appends.
vi.mock('../../usecase/sync-helpers', async () => {
  const { getDb: db } = await import('../../lib/db');
  return {
    withAtomicSyncTransaction: (projectId: string, work: (tx: unknown, sync: (...args: unknown[]) => Promise<void>) => Promise<unknown>) =>
      db().transaction(tx => work(tx, async (...args: unknown[]) => { mocks.sync.push([projectId, ...args]); })),
  };
});
vi.mock('./share-link-api', () => ({
  shareLinkApi: {
    acknowledge: async (imported: string[], withdrawn: string[]) => { mocks.acknowledged.push([imported, withdrawn]); },
    setStatuses: async (updates: unknown[]) => { mocks.statuses.push(...updates); },
  },
}));

import { applyShareInbox } from './share-inbox';
import { isShareLinkComment } from './share-comment';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
beforeEach(() => {
  mocks.sync.length = 0;
  mocks.acknowledged.length = 0;
  mocks.statuses.length = 0;
});

const remote = (id: string, projectId = INPUT.projectId): ShareInboxComment => ({
  id,
  shareId: 'share-1',
  projectId,
  entityKind: 'node',
  entityId: 'chapter',
  authorName: '合成读者',
  body: '这里节奏太快',
  anchor: {
    targetBlockId: 'block-1', targetBlockIds: ['block-1'], selectedText: 'Synthetic',
    blockText: 'Synthetic body.', blockSelectionFrom: 0, blockSelectionTo: 9,
    blockSnapshots: [{ blockId: 'block-1', blockText: 'Synthetic body.' }],
    textAnchor: { startBlockId: 'block-1', startOffset: 0, endBlockId: 'block-1', endOffset: 9, text: 'Synthetic' },
  },
  status: 'open',
  createdAt: NOW,
});
const inbox = (patch: Partial<ShareInbox>): ShareInbox => ({ comments: [], withdrawals: [], imported: [], ...patch });
const row = async (id: string) => (await getDb().select().from(CommentTable).where(eq(CommentTable.id, id)))[0];

describe('share link inbox', () => {
  it('imports readers\' comments once as anchored external notes and acknowledges them', async () => {
    const fixture = await createWorkspaceProjectionFixture();
    cleanups.push(fixture.close);
    const changed: string[] = [];
    const listener = (event: { projectId: string }) => changed.push(event.projectId);
    events.on('sync:project-changed', listener);
    cleanups.push(async () => events.off('sync:project-changed', listener));

    const first = await applyShareInbox(inbox({ comments: [remote('reader-1'), remote('elsewhere', 'not-restored-here')] }));
    expect(first).toEqual({ imported: 1, withdrawn: 0, statusesReported: 0, arrived: [remote('reader-1')] });
    const imported = await row('reader-1');
    expect(imported).toMatchObject({
      projectId: INPUT.projectId, kind: 'note', targetKind: 'node', targetId: 'chapter', targetBlockId: 'block-1',
      authorKind: 'external', authorId: null, authorName: '合成读者', status: 'open', source: 'api',
      targetBlockIdsJson: '["block-1"]', createdAt: NOW,
    });
    expect(JSON.parse(imported!.anchorJson).textAnchor).toEqual(remote('x').anchor.textAnchor);
    expect(JSON.parse(imported!.bodyJson).content[0].content[0].text).toBe('这里节奏太快');
    expect(isShareLinkComment({ authorKind: imported!.authorKind as 'external', metadataJson: imported!.metadataJson })).toBe(true);
    expect(mocks.sync).toEqual([[INPUT.projectId, 'comment', 'create', 'reader-1', INPUT.projectId, expect.objectContaining({ id: 'reader-1', authorKind: 'external' })]]);
    expect(mocks.acknowledged).toEqual([[['reader-1'], []]]);
    expect(changed).toEqual([INPUT.projectId]);

    // A second device that read the inbox before the acknowledgement writes nothing new.
    expect((await applyShareInbox(inbox({ comments: [remote('reader-1')] }))).arrived).toEqual([]);
    expect(mocks.sync).toHaveLength(1);
    expect(mocks.acknowledged[mocks.acknowledged.length - 1]).toEqual([['reader-1'], []]);
  });

  it('removes withdrawn comments and reports the owner\'s resolutions back to readers', async () => {
    const fixture = await createWorkspaceProjectionFixture();
    cleanups.push(fixture.close);
    await applyShareInbox(inbox({ comments: [remote('kept'), remote('resolved'), remote('converted'), remote('withdrawn')] }));
    await getDb().update(CommentTable).set({ status: 'resolved', resolvedAt: NOW }).where(eq(CommentTable.id, 'resolved'));
    await getDb().update(CommentTable).set({ status: 'converted' }).where(eq(CommentTable.id, 'converted'));
    mocks.sync.length = 0;
    mocks.acknowledged.length = 0;

    const result = await applyShareInbox(inbox({
      withdrawals: [
        { id: 'withdrawn', shareId: 'share-1', projectId: INPUT.projectId },
        { id: 'already-deleted', shareId: 'share-1', projectId: INPUT.projectId },
        { id: 'not-here', shareId: 'share-1', projectId: 'not-restored-here' },
      ],
      imported: ['kept', 'resolved', 'converted', 'already-deleted'].map(id => ({ id, projectId: INPUT.projectId, status: 'open' as const })),
    }));
    expect(result).toEqual({ imported: 0, withdrawn: 2, statusesReported: 2, arrived: [] });
    expect(await row('withdrawn')).toBeUndefined();
    expect(await row('kept')).toBeDefined();
    expect(mocks.sync).toEqual([[INPUT.projectId, 'comment', 'delete', 'withdrawn', INPUT.projectId]]);
    expect(mocks.acknowledged).toEqual([[[], ['withdrawn', 'already-deleted']]]);
    expect(mocks.statuses).toEqual([{ id: 'resolved', status: 'resolved' }, { id: 'converted', status: 'resolved' }]);

    await applyShareInbox(inbox({ imported: [{ id: 'resolved', projectId: INPUT.projectId, status: 'resolved' }] }));
    expect(mocks.statuses).toHaveLength(2);
  });
});
