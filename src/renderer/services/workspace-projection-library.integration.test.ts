import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryItemTable, WorkspaceProjectionClockTable } from '../schema/drizzle';
import { createLibraryItemSqliteRepository } from '../sqlite-repo/library-item-repo';
import { useDataStore } from '../store/data-store';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const value = await createWorkspaceProjectionFixture(); cleanups.push(value.close);
  await value.db.insert(LibraryItemTable).values(['z', 'a', 'm'].map(id => ({ id, projectId: INPUT.projectId, kind: 'text', title: id, createdAt: NOW, updatedAt: NOW })));
  return value;
}
async function compare(previous: NonNullable<Awaited<ReturnType<typeof captureWorkspaceProjection>>>, mode: 'all' | 'changed' | 'reuse') {
  const selected = (await captureWorkspaceProjection({ ...INPUT, previous }))!;
  const full = (await captureWorkspaceProjection(INPUT))!;
  expect(selected.libraryRead).toBe(mode);
  expect(selected.data).toEqual(full.data);
  return selected;
}

describe('covered library projection', () => {
  it('reads changed body/notes and preserves other objects in exact SQLite order including ties', async () => {
    const { db, capture } = await fixture(); let previous = (await capture())!;
    for (const [updatedAt, orderKey] of [['2027-01-01', 0], [NOW, 0], ['2020-01-01', -1], [NOW, 9]] as const) {
      await db.update(LibraryItemTable).set({ title: 'Updated', bodyJson: JSON.stringify({ synthetic: updatedAt }), notesJson: 'null', updatedAt, orderKey }).where(eq(LibraryItemTable.id, 'a'));
      const next = await compare(previous, 'changed');
      for (const item of next.data.libraryItems) if (item.id !== 'a') expect(item).toBe(previous.data.libraryItems.find(({ id }) => id === item.id));
      expect(next.data.libraryItems.find(({ id }) => id === 'a')).toMatchObject({ title: 'Updated', notesJson: 'null', bodyJson: JSON.stringify({ synthetic: updatedAt }) });
      expect(next.data.bookElements).toBe(previous.data.bookElements);
      previous = next;
    }
  });
  it('decodes a valid payload-kind change without retaining the old text body', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    await db.update(LibraryItemTable).set({ kind: 'url', bodyJson: null, externalUrl: 'https://example.invalid/synthetic', previewImageUrl: 'https://example.invalid/preview' }).where(eq(LibraryItemTable.id, 'library'));
    const next = await compare(previous, 'changed');
    expect(next.data.libraryItems.find(({ id }) => id === 'library')).toMatchObject({ kind: 'url', bodyJson: null, externalUrl: 'https://example.invalid/synthetic' });
  });
  it.each(['insert', 'delete', 'replace', 'project-move', 'id-change', 'reset', 'large-batch'] as const)('falls back on %s', async change => {
    const { db, capture } = await fixture();
    if (change === 'large-batch') await db.transaction(async tx => {
      for (let i = 0; i < 129; i++) await tx.insert(LibraryItemTable).values({ id: `large-${i}`, projectId: INPUT.projectId, kind: 'text', title: 'Synthetic', createdAt: NOW, updatedAt: NOW });
    });
    const previous = (await capture())!;
    const [old] = await db.select().from(LibraryItemTable).where(eq(LibraryItemTable.id, 'a'));
    if (change === 'insert') await db.insert(LibraryItemTable).values({ ...old!, id: 'new' });
    if (change === 'delete' || change === 'replace') await db.delete(LibraryItemTable).where(eq(LibraryItemTable.id, 'a'));
    if (change === 'replace') await db.insert(LibraryItemTable).values(old!);
    if (change === 'project-move') await db.update(LibraryItemTable).set({ projectId: 'other-project' }).where(eq(LibraryItemTable.id, 'a'));
    if (change === 'id-change') await db.update(LibraryItemTable).set({ id: 'renamed' }).where(eq(LibraryItemTable.id, 'a'));
    if (change === 'reset') await db.delete(WorkspaceProjectionClockTable).where(eq(WorkspaceProjectionClockTable.projectId, INPUT.projectId));
    if (change === 'large-batch') await db.update(LibraryItemTable).set({ title: 'Changed' }).where(eq(LibraryItemTable.projectId, INPUT.projectId));
    await compare(previous, 'all');
  });
  it('keeps exactly 128 covered edits scoped and replays the cursor safely', async () => {
    const { db, capture } = await fixture();
    await db.transaction(async tx => {
      for (let i = 0; i < 124; i++) await tx.insert(LibraryItemTable).values({ id: `batch-${i}`, projectId: INPUT.projectId, kind: 'text', title: 'Synthetic', createdAt: NOW, updatedAt: NOW });
    });
    const previous = (await capture())!;
    await db.update(LibraryItemTable).set({ title: 'Changed' }).where(eq(LibraryItemTable.projectId, INPUT.projectId));
    await compare(previous, 'changed'); await compare(previous, 'changed');
  });
  it('ignores other project writes and rolled-back updates; repository queries stay scoped', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    await expect(db.transaction(async tx => { await tx.update(LibraryItemTable).set({ title: 'Aborted' }).where(eq(LibraryItemTable.id, 'a')); throw new Error('Rollback'); })).rejects.toThrow('Rollback');
    await db.insert(LibraryItemTable).values({ id: 'foreign', projectId: 'other-project', kind: 'text', title: 'Foreign', createdAt: NOW, updatedAt: NOW });
    const next = await compare(previous, 'reuse'); expect(next.data.libraryItems).toBe(previous.data.libraryItems);
    const repo = createLibraryItemSqliteRepository(INPUT.projectId, db);
    expect(await repo.findAll([])).toEqual([]); expect(await repo.findAll(['foreign'])).toEqual([]);
    expect(await repo.findOrderedIds()).toEqual(next.data.libraryItems.map(({ id }) => id));
  });
  it('fails a scoped read without publishing partial data and allows a later retry', async () => {
    const { db, gateway, capture } = await fixture(); const previous = (await capture())!;
    await db.update(LibraryItemTable).set({ title: 'Changed' }).where(eq(LibraryItemTable.id, 'a'));
    const before = useDataStore.getState(); const query = gateway.query.bind(gateway);
    gateway.query = async (...args) => { if (/from "library_item"/i.test(args[0])) throw new Error('Synthetic read failure'); return query(...args); };
    await expect(captureWorkspaceProjection({ ...INPUT, previous })).rejects.toThrow();
    expect(useDataStore.getState()).toBe(before);
    gateway.query = query; await compare(previous, 'changed');
  });
  it('rejects a delayed capture after a newer optimistic library publication', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, previous.data, undefined, previous.coverage?.epoch ?? null);
    await db.update(LibraryItemTable).set({ title: 'Remote' }).where(eq(LibraryItemTable.id, 'a'));
    const refresh = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'refreshing'); const base = useDataStore.getState();
    const delayed = await compare(previous, 'changed');
    const optimistic = base.libraryItems.map(item => item.id === 'a' ? { ...item, title: 'Newer local' } : item);
    useDataStore.setState({ libraryItems: optimistic });
    expect(useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, refresh, delayed.data, base, delayed.coverage?.epoch ?? null)).toBe(false);
    expect(useDataStore.getState().libraryItems).toBe(optimistic);
  });
});
