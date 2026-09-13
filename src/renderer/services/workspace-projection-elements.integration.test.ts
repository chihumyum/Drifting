import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { BookElementTable, ElementCategoryTable, WorkspaceProjectionClockTable } from '../schema/drizzle';
import { createBookElementSqliteRepository } from '../sqlite-repo/element-repo';
import { useDataStore } from '../store/data-store';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT, WORKSPACE_TEST_NOW as NOW } from './workspace-projection.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const value = await createWorkspaceProjectionFixture(); cleanups.push(value.close);
  await value.db.insert(BookElementTable).values(['z', 'a', 'm'].map((id) => ({ id, projectId: INPUT.projectId, name: id, createdAt: NOW, updatedAt: NOW })));
  return value;
}

async function compare(previous: NonNullable<Awaited<ReturnType<typeof captureWorkspaceProjection>>>, mode: 'all' | 'changed' | 'reuse') {
  const selected = (await captureWorkspaceProjection({ ...INPUT, previous }))!;
  const full = (await captureWorkspaceProjection(INPUT))!;
  expect(selected.elementRead).toBe(mode);
  expect(selected.data).toEqual(full.data);
  expect([...selected.data.trashedEntityIds]).toEqual([...full.data.trashedEntityIds]);
  return selected;
}

describe('covered element projection', () => {
  it('reads only the edited body, preserves unchanged objects and follows SQLite ordering including ties', async () => {
    const { db, capture } = await fixture(); let previous = (await capture())!;
    for (const stamp of ['2027-01-01', NOW, '2020-01-01']) {
      await db.update(BookElementTable).set({ updatedAt: stamp, contentJson: JSON.stringify({ synthetic: stamp }), aliasesJson: '["Alias"]' }).where(eq(BookElementTable.id, 'a'));
      const next = await compare(previous, 'changed');
      for (const element of next.data.bookElements) if (element.id !== 'a') expect(element).toBe(previous.data.bookElements.find(({ id }) => id === element.id));
      expect(next.data.trashedEntityIds).toBe(previous.data.trashedEntityIds);
      expect(next.data.bookElements.find(({ id }) => id === 'a')?.aliases).toEqual(['Alias']);
      previous = next;
    }
  });

  it.each(['insert', 'delete', 'soft-delete', 'restore', 'replace', 'project-move', 'id-change', 'reset', 'large-batch'] as const)('falls back on %s without losing identity, order or trash', async (change) => {
    const { db, capture } = await fixture();
    if (change === 'restore') await db.update(BookElementTable).set({ deletedAt: NOW }).where(eq(BookElementTable.id, 'a'));
    if (change === 'large-batch') await db.transaction(async (tx) => {
      for (let index = 0; index < 129; index++) await tx.insert(BookElementTable).values({ id: `large-${index}`, projectId: INPUT.projectId, name: 'Synthetic', createdAt: NOW, updatedAt: NOW });
    });
    const previous = (await capture())!;
    const [old] = await db.select().from(BookElementTable).where(eq(BookElementTable.id, 'a'));
    if (change === 'insert') await db.insert(BookElementTable).values({ ...old!, id: 'new' });
    if (change === 'delete' || change === 'replace') await db.delete(BookElementTable).where(eq(BookElementTable.id, 'a'));
    if (change === 'replace') await db.insert(BookElementTable).values(old!);
    if (change === 'soft-delete' || change === 'restore') await db.update(BookElementTable).set({ deletedAt: change === 'restore' ? null : NOW }).where(eq(BookElementTable.id, 'a'));
    if (change === 'project-move') await db.update(BookElementTable).set({ projectId: 'other-project' }).where(eq(BookElementTable.id, 'a'));
    if (change === 'id-change') await db.update(BookElementTable).set({ id: 'renamed' }).where(eq(BookElementTable.id, 'a'));
    if (change === 'reset') await db.delete(WorkspaceProjectionClockTable).where(eq(WorkspaceProjectionClockTable.projectId, INPUT.projectId));
    if (change === 'large-batch') await db.update(BookElementTable).set({ name: 'Changed' }).where(eq(BookElementTable.projectId, INPUT.projectId));
    await compare(previous, 'all');
  });

  it('keeps a 128-row covered batch scoped and replays the same cursor safely', async () => {
    const { db, capture } = await fixture();
    await db.transaction(async (tx) => {
      for (let index = 0; index < 124; index++) await tx.insert(BookElementTable).values({ id: `batch-${index}`, projectId: INPUT.projectId, name: 'Synthetic', createdAt: NOW, updatedAt: NOW });
    });
    const previous = (await capture())!;
    await db.update(BookElementTable).set({ name: 'Changed', updatedAt: '2027-01-01' }).where(eq(BookElementTable.projectId, INPUT.projectId));
    await compare(previous, 'changed'); await compare(previous, 'changed');
  });

  it('reads the complete trash slice for an edit to an already trashed element', async () => {
    const { db, capture } = await fixture();
    await db.update(BookElementTable).set({ deletedAt: NOW }).where(eq(BookElementTable.id, 'a'));
    const previous = (await capture())!;
    await db.update(BookElementTable).set({ name: 'Trashed edit' }).where(eq(BookElementTable.id, 'a'));
    await compare(previous, 'all');
  });

  it('captures category detachment with its dependent elements in the same projection', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    await db.delete(ElementCategoryTable).where(eq(ElementCategoryTable.id, 'category'));
    const next = await compare(previous, 'changed');
    expect(next.data.bookElements.find(({ id }) => id === 'element')?.categoryId).toBeNull();
    expect(next.data.bookElementCategories).toEqual([]);
  });

  it('reuses the accepted elements after an aborted write or another project edit', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    await expect(db.transaction(async (tx) => { await tx.update(BookElementTable).set({ name: 'Aborted' }).where(eq(BookElementTable.id, 'a')); throw new Error('Rollback'); })).rejects.toThrow('Rollback');
    await db.insert(BookElementTable).values({ id: 'foreign', projectId: 'other-project', name: 'Foreign', createdAt: NOW, updatedAt: NOW });
    const next = await compare(previous, 'reuse'); expect(next.data.bookElements).toBe(previous.data.bookElements);
    const repo = createBookElementSqliteRepository(INPUT.projectId, db);
    expect(await repo.findAll([])).toEqual([]);
    expect(await repo.findAll(['foreign'])).toEqual([]);
  });

  it('rejects a captured element update after a newer optimistic publication', async () => {
    const { db, capture } = await fixture(); const previous = (await capture())!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, previous.data, undefined, previous.coverage?.epoch ?? null);
    await db.update(BookElementTable).set({ name: 'Remote' }).where(eq(BookElementTable.id, 'a'));
    const refresh = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'refreshing'); const base = useDataStore.getState();
    const delayed = await compare(previous, 'changed');
    const optimistic = base.bookElements.map((element) => element.id === 'a' ? { ...element, name: 'Newer local' } : element);
    useDataStore.setState({ bookElements: optimistic });
    expect(useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, refresh, delayed.data, base, delayed.coverage?.epoch ?? null)).toBe(false);
    expect(useDataStore.getState().bookElements).toBe(optimistic);
  });
});
