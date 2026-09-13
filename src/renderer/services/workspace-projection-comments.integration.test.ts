import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { CommentActionTable, CommentTable, WorkspaceProjectionClockTable } from '../schema/drizzle';
import { createCommentActionRepository, createCommentRepository } from '../sqlite-repo/comment-repo';
import { useDataStore } from '../store/data-store';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
type Capture = NonNullable<Awaited<ReturnType<typeof captureWorkspaceProjection>>>;
async function compare(previous: Capture) {
  const next = (await captureWorkspaceProjection({ ...INPUT, previous }))!;
  expect(next.data).toEqual((await captureWorkspaceProjection(INPUT))!.data);
  return next;
}

for (const kind of ['comments', 'actions'] as const) describe(`covered ${kind} projection`, () => {
  const table = kind === 'comments' ? CommentTable : CommentActionTable;
  const dataKey = kind === 'comments' ? 'comments' : 'commentActions';
  const readKey = kind === 'comments' ? 'commentRead' : 'commentActionRead';
  async function fixture(extra = 0) {
    const value = await createWorkspaceProjectionFixture(); cleanups.push(value.close);
    await value.db.transaction(async tx => {
      for (const id of ['z', 'a', 'm', ...Array.from({ length: extra }, (_, i) => `batch-${i}`)]) {
        const row = { id, projectId: INPUT.projectId, createdAt: NOW, updatedAt: NOW };
        if (kind === 'comments') await tx.insert(CommentTable).values({ ...row, bodyJson: '{"text":"Synthetic"}' });
        else await tx.insert(CommentActionTable).values({ ...row, commentId: 'comment', kind: 'accept_suggestion', payloadJson: '{"text":"Synthetic"}' });
      }
    });
    return value;
  }
  it('replaces only changed JSON/status rows, preserving object identity and createdAt/rowid ties', async () => {
    const { db, capture } = await fixture(); let previous = (await capture())!;
    expect(previous.data[dataKey].map(row => row.id)).toEqual([kind === 'comments' ? 'comment' : 'action', 'z', 'a', 'm']);
    for (const updatedAt of ['2027-01-01', NOW, '2020-01-01']) {
      if (kind === 'comments') await db.update(CommentTable).set({ status: 'resolved', bodyJson: '{"text":"Revised"}', anchorJson: '{"synthetic":true}', resolvedAt: NOW, updatedAt }).where(eq(CommentTable.id, 'a'));
      else await db.update(CommentActionTable).set({ status: 'applied', payloadJson: '{"text":"Revised"}', resultJson: '{"synthetic":true}', appliedAt: NOW, updatedAt }).where(eq(CommentActionTable.id, 'a'));
      const next = await compare(previous); expect(next[readKey]).toBe('changed');
      for (const row of next.data[dataKey]) if (row.id !== 'a') expect(row).toBe(previous.data[dataKey].find(old => old.id === row.id));
      expect(next.data[dataKey].find(row => row.id === 'a')).not.toBe(previous.data[dataKey].find(row => row.id === 'a'));
      expect(next.data.bookNodes).toBe(previous.data.bookNodes);
      expect((await compare(next))[readKey]).toBe('reuse');
      previous = next;
    }
  });
  it.each(['insert', 'delete', 'replace', 'project-move', 'id-change', 'order-change', 'expired', 'reset'] as const)('falls back on %s', async change => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    if (kind === 'comments') {
      const [old] = await db.select().from(CommentTable).where(eq(CommentTable.id, 'a'));
      if (change === 'insert') await db.insert(CommentTable).values({ ...old!, id: 'new' });
      if (change === 'delete' || change === 'replace') await db.delete(CommentTable).where(eq(CommentTable.id, 'a'));
      if (change === 'replace') await db.insert(CommentTable).values(old!);
    } else {
      const [old] = await db.select().from(CommentActionTable).where(eq(CommentActionTable.id, 'a'));
      if (change === 'insert') await db.insert(CommentActionTable).values({ ...old!, id: 'new' });
      if (change === 'delete' || change === 'replace') await db.delete(CommentActionTable).where(eq(CommentActionTable.id, 'a'));
      if (change === 'replace') await db.insert(CommentActionTable).values(old!);
    }
    if (change === 'project-move') await db.update(table).set({ projectId: 'other-project' }).where(eq(table.id, 'a'));
    if (change === 'id-change') await db.update(table).set({ id: 'renamed' }).where(eq(table.id, 'a'));
    if (change === 'order-change') await db.update(table).set({ createdAt: '2020-01-01' }).where(eq(table.id, 'a'));
    if (change === 'expired') {
      await db.update(table).set({ updatedAt: '2027-01-01' }).where(eq(table.id, 'a'));
      await db.update(WorkspaceProjectionClockTable).set({ retainedAfter: previous.coverage!.revision + 1 }).where(eq(WorkspaceProjectionClockTable.projectId, INPUT.projectId));
    }
    if (change === 'reset') await db.delete(WorkspaceProjectionClockTable).where(eq(WorkspaceProjectionClockTable.projectId, INPUT.projectId));
    expect((await compare(previous))[readKey]).toBe('all');
  });
  it.each([128, 129])('bounds %i covered identities and safely replays the same cursor', async count => {
    const { db, capture } = await fixture(count - 4); const previous = (await capture())!;
    await db.update(table).set({ updatedAt: '2027-01-01' }).where(eq(table.projectId, INPUT.projectId));
    expect((await compare(previous))[readKey]).toBe(count === 128 ? 'changed' : 'all');
    expect((await compare(previous))[readKey]).toBe(count === 128 ? 'changed' : 'all');
  });
  it('ignores rollback/other project writes, scopes ID reads, and returns no SQL for empty IDs', async () => {
    const { db, gateway, capture } = await fixture(); const previous = (await capture())!;
    await expect(db.transaction(async tx => { await tx.update(table).set({ updatedAt: '2027-01-01' }).where(eq(table.id, 'a')); throw new Error('Rollback'); })).rejects.toThrow('Rollback');
    await db.insert(CommentTable).values({ id: 'foreign', projectId: 'other-project', createdAt: NOW, updatedAt: NOW });
    await db.insert(CommentActionTable).values({ id: 'foreign-action', commentId: 'foreign', kind: 'accept_suggestion', projectId: 'other-project', createdAt: NOW, updatedAt: NOW });
    const next = await compare(previous); expect(next[readKey]).toBe('reuse'); expect(next.data[dataKey]).toBe(previous.data[dataKey]);
    const repo = kind === 'comments' ? createCommentRepository(INPUT.projectId, db) : createCommentActionRepository(INPUT.projectId, db);
    expect(await repo.findAll(['foreign', 'foreign-action'])).toEqual([]);
    expect((await repo.findAll(['m', 'z', 'a'])).map(row => row.id)).toEqual(['z', 'a', 'm']);
    const query = gateway.query.bind(gateway); gateway.query = async () => { throw new Error('Unexpected SQL'); };
    expect(await repo.findAll([])).toEqual([]); gateway.query = query;
    if (kind === 'actions') expect((await createCommentActionRepository(INPUT.projectId, db).findByComment('comment')).map(row => row.id)).toEqual(['action', 'z', 'a', 'm']);
  });
  it('fails a scoped read without publishing partial data and permits retry', async () => {
    const { db, gateway, capture } = await fixture(); const previous = (await capture())!;
    await db.update(table).set({ updatedAt: '2027-01-01' }).where(eq(table.id, 'a'));
    const before = useDataStore.getState(); const query = gateway.query.bind(gateway);
    gateway.query = async (...args) => { if (args[0].includes(`from "${kind === 'comments' ? 'comment' : 'comment_action'}"`)) throw new Error('Synthetic read failure'); return query(...args); };
    await expect(captureWorkspaceProjection({ ...INPUT, previous })).rejects.toThrow(); expect(useDataStore.getState()).toBe(before);
    gateway.query = query; expect((await compare(previous))[readKey]).toBe('changed');
  });
  it('rejects a delayed capture after a newer local publication', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    expect(useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, previous.data, undefined, previous.coverage?.epoch ?? null)).toBe(true);
    await db.update(table).set({ updatedAt: '2027-01-01' }).where(eq(table.id, 'a'));
    const refresh = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'refreshing'); const base = useDataStore.getState();
    const delayed = await compare(previous);
    if (kind === 'comments') useDataStore.setState({ comments: base.comments.map(row => row.id === 'a' ? { ...row, bodyJson: 'Newer' } : row) });
    else useDataStore.setState({ commentActions: base.commentActions.map(row => row.id === 'a' ? { ...row, resultJson: 'Newer' } : row) });
    const optimistic = useDataStore.getState()[dataKey];
    expect(useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, refresh, delayed.data, base, delayed.coverage?.epoch ?? null)).toBe(false);
    expect(useDataStore.getState()[dataKey]).toBe(optimistic);
  });
});

it('captures a resolved comment and applied action atomically from one transaction', async () => {
  const f = await createWorkspaceProjectionFixture(); cleanups.push(f.close); const previous = (await f.capture())!;
  await f.db.transaction(async tx => {
    await tx.update(CommentTable).set({ status: 'resolved', bodyJson: 'Synthetic revision' }).where(eq(CommentTable.id, 'comment'));
    await tx.update(CommentActionTable).set({ status: 'applied', resultJson: '{"synthetic":true}' }).where(eq(CommentActionTable.id, 'action'));
  });
  const next = await compare(previous); expect([next.commentRead, next.commentActionRead]).toEqual(['changed', 'changed']);
  expect(next.data.comments[0]!.status).toBe('resolved'); expect(next.data.commentActions[0]!.status).toBe('applied');
});
it('cascades parent deletion and identity replacement without retaining actions', async () => {
  const f = await createWorkspaceProjectionFixture(); cleanups.push(f.close); const previous = (await f.capture())!;
  const [old] = await f.db.select().from(CommentTable);
  await f.db.transaction(async tx => { await tx.delete(CommentTable).where(eq(CommentTable.id, 'comment')); await tx.insert(CommentTable).values(old!); });
  const next = await compare(previous); expect([next.commentRead, next.commentActionRead]).toEqual(['all', 'all']);
  expect(next.data.comments).toHaveLength(1); expect(next.data.commentActions).toEqual([]);
});
it('keeps a stable action order while changing its parent association', async () => {
  const f = await createWorkspaceProjectionFixture(); cleanups.push(f.close);
  await f.db.insert(CommentTable).values({ id: 'new-parent', projectId: INPUT.projectId, createdAt: NOW, updatedAt: NOW });
  const previous = (await f.capture())!;
  await f.db.update(CommentActionTable).set({ commentId: 'new-parent' }).where(eq(CommentActionTable.id, 'action'));
  const next = await compare(previous); expect(next.commentActionRead).toBe('changed'); expect(next.commentRead).toBe('reuse');
  expect(next.data.commentActions[0]!.commentId).toBe('new-parent');
});
