import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectEntityLinkNames, releaseEntityLinkNames } from '../lib/entity-link-names';
import { buildEntityLinkColorSignature, DEFAULT_ENTITY_LINK_KIND_COLORS } from '../lib/entity-link-appearance';
import { BookNodeTable, CommentTable, SyncGenerationTable, WorkspaceProjectionClockTable } from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import { createWorkspaceProjectionFixture, WORKSPACE_TEST_INPUT as INPUT } from './workspace-projection.test-support';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionRefresh } from './workspace-projection-refresh';

const initial = useDataStore.getState(); const projectInitial = useProjectStore.getState();
let fixture: Awaited<ReturnType<typeof createWorkspaceProjectionFixture>>;
const cleanup: Array<() => void> = [];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const colors = () => buildEntityLinkColorSignature(useDataStore.getState(), 'contextual', DEFAULT_ENTITY_LINK_KIND_COLORS);
const names = () => selectEntityLinkNames(useDataStore.getState());
function worker(capture = captureWorkspaceProjection) {
  const published = vi.fn(); const errors = vi.fn();
  const owner = createWorkspaceProjectionRefresh({ ...INPUT, capture, onPublished: published, onMissing: () => undefined, onError: errors });
  cleanup.push(() => owner.dispose()); return { owner, published, errors };
}
async function replaceGeneration() {
    await fixture.db.transaction(async tx => {
      const [old] = await tx.select().from(SyncGenerationTable).where(eq(SyncGenerationTable.syncGenerationId, 'workspace-generation'));
      await tx.update(SyncGenerationTable).set({ status: 'retired', retiredAt: '2026-09-13T00:00:00.000Z' }).where(eq(SyncGenerationTable.syncGenerationId, old.syncGenerationId));
      await tx.insert(SyncGenerationTable).values({ ...old, syncGenerationId: 'workspace-generation-2', generationNumber: 2, status: 'active', retiredAt: null });
    });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fixture = await createWorkspaceProjectionFixture(); const captured = (await fixture.capture())!;
  const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
  useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, captured.data, undefined, captured.coverage?.epoch ?? null);
  useProjectStore.getState().setCurrentProject(captured.project);
});
afterEach(async () => {
  cleanup.splice(0).reverse().forEach(dispose => dispose());
  expect(fixture.gateway.database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  expect(fixture.gateway.database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  releaseEntityLinkNames(INPUT.projectId); useDataStore.setState(initial, true); useProjectStore.setState(projectInitial, true);
  await fixture.close(); vi.useRealTimers();
});

describe('committed workspace generation with real SQLite refresh', () => {
  it.each(['comments', 'metrics'] as const)('keeps names and appearance stable through %s request and commit', async kind => {
    const before = useDataStore.getState(); const selected = names(); const color = colors();
    let notifications = 0; const off = useDataStore.subscribe(() => { if (names() !== selected) notifications++; }); cleanup.push(off);
    if (kind === 'comments') await fixture.db.update(CommentTable).set({ bodyJson: '{"text":"Synthetic changed comment"}' });
    else await fixture.db.update(BookNodeTable).set({ wordCount: 321 }).where(eq(BookNodeTable.id, 'chapter'));
    const { owner, published } = worker(); owner.requestChanges();
    expect(names()).toBe(selected); expect(colors()).toBe(color);
    await owner.flush(); expect(published).toHaveBeenCalledTimes(1);
    const after = useDataStore.getState();
    expect(after.workspaceProjectionEpoch).toBeGreaterThan(before.workspaceProjectionEpoch);
    expect(names()).toBe(selected); expect(colors()).toBe(color); expect(notifications).toBe(0);
    expect(after.workspaceProjectionGeneration).toBe(before.workspaceProjectionGeneration);
    if (kind === 'metrics') expect(after.bookNodes.find(node => node.id === 'chapter')?.wordCount).toBe(321);
    else expect(after.comments[0].bodyJson).toBe('{"text":"Synthetic changed comment"}');
  });
  it('keeps committed names throughout a failed refresh and the subsequent retry', async () => {
    const selected = names(); const { owner, errors } = worker(vi.fn(captureWorkspaceProjection).mockRejectedValueOnce(new Error('Synthetic capture failure')));
    owner.requestChanges(); await owner.flush(); expect(errors).toHaveBeenCalledTimes(1); expect(names()).toBe(selected);
    owner.request(); await owner.flush(); expect(names()).toBe(selected); expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });
  it('publishes a renamed target only when its full capture commits', async () => {
    const before = names(); const entered = deferred(); const release = deferred();
    await fixture.db.update(BookNodeTable).set({ title: 'Synthetic renamed chapter' }).where(eq(BookNodeTable.id, 'chapter'));
    const { owner } = worker(async input => { const result = await captureWorkspaceProjection(input); entered.resolve(); await release.promise; return result; });
    owner.request(); const running = owner.flush(); await entered.promise;
    const pending = names(); release.resolve(); await running;
    expect(pending).toBe(before); expect(names().nodes.find(node => node.id === 'chapter')?.title).toBe('Synthetic renamed chapter');
  });
  it('replaces name and record identities atomically on a real generation change', async () => {
    const before = useDataStore.getState(); const selected = names();
    await replaceGeneration();
    const { owner } = worker(); owner.request(); const pending = names(); await owner.flush(); const after = useDataStore.getState();
    expect(pending).toBe(selected); expect(after.workspaceProjectionGeneration).not.toBe(before.workspaceProjectionGeneration);
    expect(names()).not.toBe(selected); expect(names().nodes).toEqual(selected.nodes);
    expect(after.bookNodes).not.toBe(before.bookNodes); expect(after.bookNodes[0]).not.toBe(before.bookNodes[0]);
    expect(after.bookNodes).toEqual(before.bookNodes); expect(after.nodeStorylineMapping).toEqual(before.nodeStorylineMapping);
  });
  it('rejects the old capture before publishing a newer database generation', async () => {
    const before = useDataStore.getState(); const selected = names(); const entered = deferred(); const release = deferred();
    const capture = vi.fn(captureWorkspaceProjection).mockImplementationOnce(async input => { const result = await captureWorkspaceProjection(input); entered.resolve(); await release.promise; return result; });
    const { owner, published } = worker(capture); owner.request(); const running = owner.flush(); await entered.promise;
    await replaceGeneration(); owner.request(); release.resolve(); await running;
    expect(published).not.toHaveBeenCalled(); expect(names()).toBe(selected);
    await owner.flush(); expect(published).toHaveBeenCalledTimes(1); expect(names()).not.toBe(selected);
    expect(useDataStore.getState().workspaceProjectionGeneration).not.toBe(before.workspaceProjectionGeneration);
    expect(useDataStore.getState().bookNodes[0]).not.toBe(before.bookNodes[0]);
  });
  it('does not reuse cross-capture names or records when the SQLite clock is unavailable', async () => {
    await fixture.db.delete(WorkspaceProjectionClockTable).where(eq(WorkspaceProjectionClockTable.projectId, INPUT.projectId));
    const { owner } = worker(); owner.request(); await owner.flush(); const before = useDataStore.getState(); const selected = names();
    owner.request(); await owner.flush(); const after = useDataStore.getState();
    expect(after.workspaceProjectionGeneration).not.toBe(before.workspaceProjectionGeneration);
    expect(after.bookNodes).not.toBe(before.bookNodes); expect(names()).not.toBe(selected);
  });
  it('rejects late captures across project A to B to A without changing the new generation', async () => {
    const entered = deferred(); const release = deferred();
    const { owner, published } = worker(async input => { const result = await captureWorkspaceProjection(input); entered.resolve(); await release.promise; return result; });
    owner.request(); const running = owner.flush(); await entered.promise;
    useDataStore.getState().requestWorkspaceProjection('synthetic-other-project', 'loading');
    const returned = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
    const fresh = (await fixture.capture())!;
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, returned, fresh.data, undefined, fresh.coverage?.epoch ?? null);
    const selected = names(); const state = useDataStore.getState(); release.resolve(); await running;
    expect(published).not.toHaveBeenCalled(); expect(useDataStore.getState()).toBe(state); expect(names()).toBe(selected);
  });
});
