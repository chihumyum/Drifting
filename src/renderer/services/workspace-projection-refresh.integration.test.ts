import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installHeadlessDatabaseClient } from '../lib/db';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { BookNodeTable, NodeStorylineLinkTable, ProjectTable, StorylineTable } from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { useProjectStore } from '../store/project-store';
import { trackAtomicSyncTransaction } from './atomic-sync-transaction-tracker';
import { captureWorkspaceProjection } from './workspace-projection.service';
import { createWorkspaceProjectionRefresh } from './workspace-projection-refresh';

const INPUT = { projectId: 'synthetic-project', userId: 'synthetic-user' };
const NOW = '2026-09-12T00:00:00.000Z';
const cleanups: Array<() => void | Promise<void>> = [];
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-workspace-refresh-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  let uninstall: (() => void) | null = installHeadlessDatabaseClient(db, 'synthetic-workspace.db');
  cleanups.push(() => { uninstall?.(); });
  await db.insert(ProjectTable).values({ id: INPUT.projectId, userId: INPUT.userId, name: 'Synthetic', createdAt: NOW, updatedAt: NOW });
  await db.insert(BookNodeTable).values({ id: 'node', projectId: INPUT.projectId, title: 'Before', bookOrder: 1, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
  await db.insert(StorylineTable).values(['main', 'support'].map((id, orderKey) => ({ id, projectId: INPUT.projectId, name: id, color: '#778899', orderKey, createdAt: NOW, updatedAt: NOW })));
  await db.insert(NodeStorylineLinkTable).values({ nodeId: 'node', storylineId: 'main', isPrimary: true });
  const initial = (await captureWorkspaceProjection(INPUT))!;
  const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'loading');
  useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, initial.data);
  useProjectStore.getState().setCurrentProject(initial.project);
  const write = (title: string) => db.update(BookNodeTable).set({ title }).where(eq(BookNodeTable.id, 'node'));
  const unbind = () => { uninstall?.(); uninstall = null; };
  return { db, gateway, write, unbind };
}

function worker(capture = vi.fn(captureWorkspaceProjection)) {
  const published = vi.fn(); const missing = vi.fn(); const errors = vi.fn();
  const queue = createWorkspaceProjectionRefresh({ ...INPUT, capture, onPublished: published, onMissing: missing, onError: errors });
  cleanups.push(async () => { queue.dispose(); await queue.flush(); });
  return { queue, capture, published, missing, errors };
}

function delayedCapture() {
  const captured = deferred(); const release = deferred();
  const capture = vi.fn(captureWorkspaceProjection);
  capture.mockImplementationOnce(async (input) => {
    const result = await captureWorkspaceProjection(input);
    captured.resolve(); await release.promise;
    return result;
  });
  return { capture, captured, release };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks(); vi.useRealTimers();
});

describe('workspace refresh with product SQLite', () => {
  it('coalesces a burst and publishes node and membership changes in one snapshot', async () => {
    const { db } = await fixture();
    const { queue, capture, published } = worker();
    const before = useDataStore.getState();
    for (let index = 0; index < 100; index += 1) queue.request();
    expect(useDataStore.getState().workspaceProjectionEpoch).toBe(before.workspaceProjectionEpoch + 1);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('refreshing');
    expect(useDataStore.getState().bookNodes).toBe(before.bookNodes);
    await db.transaction(async (tx) => {
      await tx.update(BookNodeTable).set({ title: 'After' }).where(eq(BookNodeTable.id, 'node'));
      await tx.delete(NodeStorylineLinkTable).where(eq(NodeStorylineLinkTable.nodeId, 'node'));
      await tx.insert(NodeStorylineLinkTable).values({ nodeId: 'node', storylineId: 'support', isPrimary: true });
    });
    const snapshots: Array<[string, string | null]> = [];
    const unsubscribe = useDataStore.subscribe((state) => {
      snapshots.push([state.bookNodes[0]!.title, state.primaryStorylineByNode.node]);
    });
    try { await queue.flush(); } finally { unsubscribe(); }
    expect(capture).toHaveBeenCalledTimes(1); expect(published).toHaveBeenCalledTimes(1);
    expect(snapshots).toEqual([['After', 'support']]);
    expect(useDataStore.getState().nodeStorylineMapping.node).toEqual(['support']);
    expect(useDataStore.getState().storylines).toBe(before.storylines);
  });

  it('starts reading at the first-arrival deadline despite repeated sync events', async () => {
    await fixture();
    const { queue, capture } = worker();
    queue.request();
    await vi.advanceTimersByTimeAsync(100); queue.request();
    await vi.advanceTimersByTimeAsync(100); queue.request();
    await vi.advanceTimersByTimeAsync(49); expect(capture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await queue.flush();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });

  it.each(['title', 'wordCount'] as const)('rejects a captured snapshot after an in-flight local %s update, then recaptures', async (field) => {
    const { db } = await fixture();
    const delayed = delayedCapture();
    const { queue, published } = worker(delayed.capture);
    queue.request(); const running = queue.flush(); await delayed.captured.promise;
    const epoch = useDataStore.getState().workspaceProjectionEpoch;
    const update = field === 'title' ? { title: 'Local edit' } : { wordCount: 42 };
    await db.update(BookNodeTable).set(update).where(eq(BookNodeTable.id, 'node'));
    useDataStore.getState().updateBookNode('node', update);
    expect(useDataStore.getState().workspaceProjectionEpoch).toBe(epoch);
    delayed.release.resolve(); await running;
    expect(published).not.toHaveBeenCalled();
    expect(useDataStore.getState().bookNodes[0]).toMatchObject(update);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('refreshing');
    await vi.advanceTimersByTimeAsync(499); expect(delayed.capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await queue.flush();
    expect(published).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().bookNodes[0]).toMatchObject(update);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });

  it('preserves an in-flight local project rename and retries before publishing project metadata', async () => {
    const { db } = await fixture();
    const delayed = delayedCapture();
    const { queue, published } = worker(delayed.capture);
    queue.request(); const running = queue.flush(); await delayed.captured.promise;
    await db.update(ProjectTable).set({ name: 'Local project name' }).where(eq(ProjectTable.id, INPUT.projectId));
    useProjectStore.getState().updateProjectInList(INPUT.projectId, { name: 'Local project name' });
    delayed.release.resolve(); await running;
    expect(published).not.toHaveBeenCalled();
    expect(useProjectStore.getState().currentProject?.name).toBe('Local project name');
    await queue.flush();
    expect(published.mock.calls[0]![0].project.name).toBe('Local project name');
  });

  it('rejects a missing result after a local projection change in the same epoch', async () => {
    const { write } = await fixture();
    const entered = deferred(); const release = deferred();
    const capture = vi.fn(captureWorkspaceProjection).mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return null;
    });
    const { queue, missing } = worker(capture);
    queue.request(); const running = queue.flush(); await entered.promise;
    await write('Restored locally');
    useDataStore.getState().updateBookNode('node', { title: 'Restored locally' });
    release.resolve(); await running;
    expect(missing).not.toHaveBeenCalled();
    expect(useDataStore.getState().bookNodes[0]!.title).toBe('Restored locally');
    await queue.flush(); expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });

  it('does not overwrite a newer full projection committed during its read', async () => {
    const { write } = await fixture();
    const delayed = delayedCapture();
    const { queue, published } = worker(delayed.capture);
    queue.request(); const running = queue.flush(); await delayed.captured.promise;
    await write('New full projection');
    const next = (await captureWorkspaceProjection(INPUT))!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'refreshing');
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, next.data);
    const before = useDataStore.getState();
    delayed.release.resolve(); await running;
    expect(published).not.toHaveBeenCalled(); expect(useDataStore.getState()).toBe(before);
  });

  it('retains a new event after an external full refresh supersedes its pending epoch', async () => {
    const { write } = await fixture();
    const { queue, capture, published } = worker();
    queue.request();
    const external = (await captureWorkspaceProjection(INPUT))!;
    const epoch = useDataStore.getState().requestWorkspaceProjection(INPUT.projectId, 'refreshing');
    useDataStore.getState().commitWorkspaceProjection(INPUT.projectId, epoch, external.data);
    await write('After external refresh');
    queue.request(); await queue.flush();
    expect(capture).toHaveBeenCalledTimes(1); expect(published).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().bookNodes[0]!.title).toBe('After external refresh');
  });

  it('backs off repeated local-write conflicts with one pending pass and recovers when writes settle', async () => {
    const { write } = await fixture();
    let changes = 0; let mutate = true;
    const capture = vi.fn(async (input: typeof INPUT) => {
      const result = await captureWorkspaceProjection(input);
      if (mutate) {
        const title = `Local ${++changes}`;
        await write(title); useDataStore.getState().updateBookNode('node', { title });
      }
      return result;
    });
    const { queue, published } = worker(capture);
    queue.request(); await queue.flush();
    for (const delay of [500, 1_000, 2_000, 4_000, 4_000]) {
      const previous = capture.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(capture).toHaveBeenCalledTimes(previous);
      await vi.advanceTimersByTimeAsync(1);
      expect(capture).toHaveBeenCalledTimes(previous + 1);
    }
    expect(published).not.toHaveBeenCalled(); mutate = false;
    await vi.advanceTimersByTimeAsync(4_000); await queue.flush();
    expect(published).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().bookNodes[0]!.title).toBe(`Local ${changes}`);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });

  it('keeps one pending request behind an in-flight read and never publishes its superseded snapshot', async () => {
    const { write } = await fixture();
    const delayed = delayedCapture();
    const { queue, published } = worker(delayed.capture);
    queue.request(); const running = queue.flush(); await delayed.captured.promise;
    await write('Newest remote');
    for (let index = 0; index < 100; index += 1) queue.request();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delayed.capture).toHaveBeenCalledTimes(1);
    delayed.release.resolve(); await running;
    expect(published).not.toHaveBeenCalled();
    await queue.flush();
    expect(delayed.capture).toHaveBeenCalledTimes(2); expect(published).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().bookNodes[0]!.title).toBe('Newest remote');
  });

  it('waits for pending author durability before starting the SQLite capture', async () => {
    const { write } = await fixture();
    const release = deferred();
    const pending = trackAtomicSyncTransaction(release.promise.then(() => write('Durable')).then(() => {}));
    const { queue, capture } = worker();
    queue.request(); const running = queue.flush();
    await Promise.resolve(); expect(capture).not.toHaveBeenCalled();
    release.resolve(); await pending; await running;
    expect(useDataStore.getState().bookNodes[0]!.title).toBe('Durable');
  });

  it.each(['missing', 'error'] as const)('does not let a superseded %s capture navigate or fail a newer refresh', async (result) => {
    await fixture();
    const entered = deferred(); const release = deferred();
    const capture = vi.fn(captureWorkspaceProjection).mockImplementationOnce(async () => {
      entered.resolve(); await release.promise;
      if (result === 'error') throw new Error('Synthetic stale failure');
      return null;
    });
    const { queue, missing, errors } = worker(capture);
    queue.request(); const running = queue.flush(); await entered.promise;
    queue.request(); release.resolve(); await running;
    expect(missing).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('refreshing');
    await queue.flush(); expect(useDataStore.getState().workspaceProjectionStatus).toBe('ready');
  });

  it('reports a current read error and supports a fresh complete retry', async () => {
    await fixture();
    const capture = vi.fn(captureWorkspaceProjection).mockRejectedValueOnce(new Error('Synthetic read failure'));
    const { queue, errors, published } = worker(capture);
    queue.request(); await queue.flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().workspaceProjectionStatus).toBe('error');
    queue.request(); await queue.flush();
    expect(published).toHaveBeenCalledTimes(1);
    expect(useDataStore.getState().workspaceProjectionError).toBeNull();
  });

  it('clears a confirmed missing project only after its authoritative capture', async () => {
    const { db } = await fixture();
    const { queue, missing, published } = worker();
    await db.delete(ProjectTable).where(eq(ProjectTable.id, INPUT.projectId));
    queue.request(); await queue.flush();
    expect(missing).toHaveBeenCalledTimes(1); expect(published).not.toHaveBeenCalled();
    expect(useDataStore.getState().workspaceProjectId).toBeNull();
    expect(useDataStore.getState().bookNodes).toEqual([]);
  });

  it.each(['project', 'dispose', 'database'] as const)('revokes an in-flight capture when its %s owner changes', async (kind) => {
    const { unbind } = await fixture();
    const delayed = delayedCapture();
    const { queue, published, missing, errors } = worker(delayed.capture);
    queue.request(); const running = queue.flush(); await delayed.captured.promise;
    if (kind === 'project') useDataStore.getState().requestWorkspaceProjection('other-project', 'loading');
    if (kind === 'dispose') queue.dispose();
    if (kind === 'database') unbind();
    const before = useDataStore.getState();
    delayed.release.resolve(); await running;
    expect(useDataStore.getState()).toBe(before);
    expect(published).not.toHaveBeenCalled(); expect(missing).not.toHaveBeenCalled(); expect(errors).not.toHaveBeenCalled();
  });

  it('cancels a scheduled capture on disposal and lets a replacement owner refresh', async () => {
    await fixture();
    const first = worker(); first.queue.request(); first.queue.dispose();
    const second = worker(); second.queue.request();
    await vi.advanceTimersByTimeAsync(250); await second.queue.flush();
    expect(first.capture).not.toHaveBeenCalled(); expect(second.published).toHaveBeenCalledTimes(1);
  });
});
