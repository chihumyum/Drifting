import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { installHeadlessDatabaseClient } from '../lib/db';
import { events } from '../lib/events';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createTestAgentAuthoredJournal } from '../lib/agent/runtime/agent-authored-journal.test-support';
import { BookElementTable, BookNodeTable, InlineMentionTable, NodeContentTable, ProjectTable, SyncGenerationTable } from '../schema/drizzle';
import { ensureActiveSyncGenerationInTransaction } from '../sync/journal/sync-generation-repository';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { onAuthoredChangeCommitted } from '../sync/journal/authored-transaction';
import { appendAuthoredYjsUpdate, appendYjsUpdateMutation } from '../sync/journal/yjs-update';
import { createElementPatchWithSync, deleteElementPatchWithSync, updateElementPatchWithSync } from '../usecase/synced-entity-commands';
import { createReferenceIndexRepository } from './reference-index-repository';
import { createReferenceIndexQueue, REFERENCE_INDEX_QUIET_MS } from './reference-index-queue';
import {
  getProjectReferenceIndexSnapshot, retainProjectReferenceIndex,
  retryProjectReferenceIndex, subscribeProjectReferenceIndex,
} from './reference-index.service';

vi.mock('../sync/journal/installation-identity', () => ({
  getSyncInstallationIdentity: async () => ({
    installationId: 'synthetic-reference-install',
    createWriterIdentity: () => ({ writerId: 'synthetic-reference-writer', writerEpoch: 'synthetic-reference-epoch' }),
  }),
}));

const NOW = '2026-09-12T00:00:00.000Z';
const cleanups: Array<() => Promise<void> | void> = [];
type Repository = ReturnType<typeof createReferenceIndexRepository>;

function json(target = 'seed-target') {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1' }, content: [
    { type: 'text', text: 'Synthetic', marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: target } }] },
  ] }] });
}

function update(target: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    const block = new Y.XmlElement('paragraph');
    block.setAttribute('id', 'block-1');
    const text = new Y.XmlText();
    text.insert(0, 'Synthetic', { entityLink: { targetKind: 'element', targetId: target } });
    block.insert(0, [text]);
    doc.getXmlFragment('default').insert(0, [block]);
    return Y.encodeStateAsUpdate(doc);
  } finally { doc.destroy(); }
}

async function fixture(count = 3) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-reference-queue-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  await db.insert(ProjectTable).values({ id: 'project-a', name: 'Synthetic', userId: 'synthetic-user', createdAt: NOW, updatedAt: NOW });
  await db.transaction((tx) => ensureActiveSyncGenerationInTransaction(tx, { projectId: 'project-a', nowIso: NOW }));
  for (let index = 0; index < count; index += 1) {
    await db.insert(BookNodeTable).values({ id: `node-${index}`, projectId: 'project-a', title: `Synthetic ${index}`, positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
    await db.insert(NodeContentTable).values({ nodeId: `node-${index}`, contentJson: json(), outlineJson: '[]', plotGridJson: '{}', createdAt: NOW, updatedAt: NOW });
  }
  const read = () => db.select().from(InlineMentionTable);
  const edit = (target: string, index = 0) => db.update(NodeContentTable).set({ contentJson: json(target) }).where(eq(NodeContentTable.nodeId, `node-${index}`));
  return { db, gateway, read, edit };
}

function worker(db: Awaited<ReturnType<typeof fixture>>['db'], decorate?: (repository: Repository) => Repository) {
  const changed = vi.fn();
  const errors = vi.fn();
  const snapshots = vi.fn();
  const repositories: Repository[] = [];
  const queue = createReferenceIndexQueue({
    isCurrent: () => true,
    createRepository: (isCurrent) => {
      const repository = createReferenceIndexRepository({ database: db, projectId: 'project-a', isCurrent });
      vi.spyOn(repository, 'captureCatalog');
      vi.spyOn(repository, 'prepareSource');
      repositories.push(repository);
      return decorate?.(repository) ?? repository;
    },
    onChanged: changed, onSnapshot: snapshots, onError: errors,
  });
  cleanups.push(async () => { queue.dispose(); await queue.flush(); });
  return { queue, changed, errors, snapshots, repositories };
}

async function mountService(db: Awaited<ReturnType<typeof fixture>>['db']) {
  const uninstall = installHeadlessDatabaseClient(db, 'synthetic-reference.db');
  cleanups.push(uninstall);
  const release = retainProjectReferenceIndex('project-a');
  cleanups.push(async () => { release(); await db.transaction(async () => {}); });
  await vi.advanceTimersByTimeAsync(0);
  expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('idle');
  return release;
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('project reference queue', () => {
  it('starts with complete coverage, merges narrow hints and preserves unrelated acknowledgements', async () => {
    const { db, edit, read } = await fixture();
    const { queue } = worker(db);
    queue.request(false, [{ kind: 'node', id: 'node-0' }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', written: 3 });
    await edit('first', 0); await edit('second', 1);
    const input = [{ kind: 'node' as const, id: 'node-0' }];
    queue.request(false, input);
    input[0]!.id = 'node-2';
    queue.request(false, [{ kind: 'node', id: 'node-1' }, { kind: 'node', id: 'node-1' }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'sources', sources: 2, written: 2 });
    expect((await read()).map((row) => row.toId).sort()).toEqual(['first', 'second', 'seed-target']);
    queue.request(); await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', reused: 3, prepared: 0 });
  });

  it('bounds accumulated source hints and lets a complete invalidation supersede them', async () => {
    const { db } = await fixture();
    const { queue } = worker(db);
    await queue.flush();
    for (let index = 0; index < 129; index += 1) queue.request(false, [{ kind: 'node', id: `node-${index}` }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', sources: 3, reused: 3 });
    queue.request(false, [{ kind: 'node', id: 'node-0' }]);
    queue.request();
    queue.request(false, [{ kind: 'node', id: 'node-1' }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun?.capture).toBe('full');
  });

  it('retains a second source arriving while a narrow pass is running', async () => {
    const { db, edit, read } = await fixture();
    let intervene = false;
    let request = () => {};
    const { queue } = worker(db, (repository) => ({ ...repository, prepareSource: async (...args) => {
      const result = await repository.prepareSource(...args);
      if (intervene) { intervene = false; await edit('second-arrival', 1); request(); }
      return result;
    } }));
    await queue.flush();
    request = () => queue.request(false, [{ kind: 'node', id: 'node-1' }]);
    intervene = true;
    await edit('first-arrival');
    queue.request(false, [{ kind: 'node', id: 'node-0' }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'sources', written: 1 });
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'sources', sources: 1, written: 1 });
    expect((await read()).map((row) => row.toId).sort()).toEqual(['first-arrival', 'second-arrival', 'seed-target']);
  });

  it('recaptures the whole project after a generation change discovered by a narrow read', async () => {
    const { db, edit, read } = await fixture();
    const { queue } = worker(db);
    await queue.flush();
    await db.transaction(async (tx) => {
      const [generation] = await tx.select().from(SyncGenerationTable);
      await tx.update(SyncGenerationTable).set({ status: 'retired', retiredAt: NOW });
      await tx.insert(SyncGenerationTable).values({ ...generation!, syncGenerationId: 'replacement-generation', generationNumber: 2 });
    });
    await edit('generation-body', 2);
    queue.request(false, [{ kind: 'node', id: 'node-0' }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'sources', stale: true, written: 0 });
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', written: 3 });
    expect((await read()).find((row) => row.fromId === 'node-2')!.toId).toBe('generation-body');
  });

  it('falls back to atomic full cleanup when a hinted source disappeared', async () => {
    const { db, read } = await fixture();
    const { queue } = worker(db);
    await queue.flush();
    await db.update(BookNodeTable).set({ deletedAt: NOW }).where(eq(BookNodeTable.id, 'node-0'));
    queue.request(false, [{ kind: 'node', id: 'node-0' }]);
    await queue.flush();
    expect(queue.getSnapshot().lastRun?.stale).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', removedSources: 1 });
    expect((await read()).map((row) => row.fromId).sort()).toEqual(['node-1', 'node-2']);
  });

  it('rechecks full coverage on a failed narrow replacement and keeps the retry bounded', async () => {
    const { db, gateway, edit, read } = await fixture();
    const { queue } = worker(db);
    await queue.flush();
    await edit('retry-narrow');
    gateway.failNextExecute((sql) => sql.startsWith('insert into "inline_mention"'));
    queue.request(false, [{ kind: 'node', id: 'node-0' }]); await queue.flush();
    expect(queue.getSnapshot()).toMatchObject({ hasError: true, lastRun: { capture: 'sources', failedSources: 1 } });
    expect((await read()).find((row) => row.fromId === 'node-0')!.toId).toBe('seed-target');
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', prepared: 1, reused: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an older narrow body and recaptures concurrent changes to other sources', async () => {
    const { db, edit, read } = await fixture();
    let intervene = false;
    const { queue } = worker(db, (repository) => ({ ...repository, prepareSource: async (...args) => {
      const prepared = await repository.prepareSource(...args);
      if (intervene) { intervene = false; await edit('newest-body'); await edit('concurrent-other', 1); }
      return prepared;
    } }));
    await queue.flush();
    await edit('older-body'); intervene = true;
    queue.request(false, [{ kind: 'node', id: 'node-0' }]); await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'sources', stale: true, written: 0 });
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', written: 2, reused: 1 });
    expect((await read()).map((row) => row.toId).sort()).toEqual(['concurrent-other', 'newest-body', 'seed-target']);
  });

  it('revokes a prepared narrow pass on forced repair before committing its rows', async () => {
    const { db, edit } = await fixture();
    let intervene = false;
    let force = () => {};
    const { queue } = worker(db, (repository) => ({ ...repository, replaceSource: async (prepared) => {
      if (intervene) { intervene = false; force(); }
      return repository.replaceSource(prepared);
    } }));
    await queue.flush();
    force = () => queue.request(true);
    await edit('repair-body'); intervene = true;
    queue.request(false, [{ kind: 'node', id: 'node-0' }]); await queue.flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'full', written: 3, stale: false });
  });
  it('starts with full coverage and coalesces 100 notifications without postponing the first window', async () => {
    const { db } = await fixture();
    const { queue, repositories, changed } = worker(db);
    queue.request(true);
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ sources: 3, prepared: 3, written: 3 });
    for (let i = 0; i < 10; i += 1) {
      for (let j = 0; j < 10; j += 1) queue.request();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(repositories[repositories.length - 1]!.captureCatalog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(repositories[repositories.length - 1]!.captureCatalog).toHaveBeenCalledTimes(2);
    expect(queue.getSnapshot().lastRun).toMatchObject({ prepared: 0, written: 0, reused: 3 });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('for 100 sources, metadata prepares 0 and a single body edit prepares and writes exactly 1', async () => {
    const { db, edit } = await fixture(100);
    const { queue } = worker(db);
    queue.request(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(queue.getSnapshot().lastRun).toMatchObject({ sources: 100, written: 100 });
    const startup = queue.getSnapshot().lastRun;
    await db.update(BookNodeTable).set({ title: 'Renamed only', wordCount: 100 });
    queue.request();
    await vi.advanceTimersByTimeAsync(REFERENCE_INDEX_QUIET_MS);
    expect(queue.getSnapshot().lastRun).toMatchObject({ prepared: 0, written: 0, reused: 100 });
    const metadata = queue.getSnapshot().lastRun;
    await edit('changed-only');
    queue.request(false, [{ kind: 'node', id: 'node-0' }]);
    await vi.advanceTimersByTimeAsync(REFERENCE_INDEX_QUIET_MS);
    expect(queue.getSnapshot().lastRun).toMatchObject({ capture: 'sources', sources: 1, prepared: 1, written: 1, reused: 0 });
    if (process.env.DRIFTING_REFERENCE_QUEUE_COUNTERS) {
      await writeFile(process.env.DRIFTING_REFERENCE_QUEUE_COUNTERS, JSON.stringify({
        sourceCount: 100, startup, metadata, oneBodyChange: queue.getSnapshot().lastRun,
      }));
    }
  });

  it('retains a request arriving during a pass and rejects its older prepared body', async () => {
    const { db, edit, read } = await fixture();
    let intervene = true;
    let request: () => void = () => {};
    const { queue } = worker(db, (repository) => ({
      ...repository,
      prepareSource: async (...args) => {
        const prepared = await repository.prepareSource(...args);
        if (intervene) { intervene = false; await edit('newer-target'); request(); }
        return prepared;
      },
    }));
    request = () => queue.request();
    await queue.flush();
    expect(queue.getSnapshot().lastRun?.stale).toBe(true);
    expect(await read()).toEqual([]);
    await vi.advanceTimersByTimeAsync(REFERENCE_INDEX_QUIET_MS);
    expect(queue.getSnapshot().phase).toBe('idle');
    expect((await read()).find((row) => row.fromId === 'node-0')!.toId).toBe('newer-target');
  });

  it('acknowledges successful sources while retrying failed sources with bounded backoff', async () => {
    const { db, gateway, read } = await fixture();
    const { queue, errors } = worker(db);
    gateway.failNextExecute((sql) => sql.startsWith('insert into "inline_mention"'));
    await queue.flush();
    expect(queue.getSnapshot()).toMatchObject({ phase: 'failed', hasError: true, lastRun: { written: 2, failedSources: 1 } });
    expect(await read()).toHaveLength(2);
    expect(errors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(await read()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(queue.getSnapshot()).toMatchObject({ phase: 'idle', hasError: false, lastRun: { prepared: 1, written: 1, reused: 2 } });
    expect(await read()).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('moves a backed-off retry forward when a new durable change repairs its source', async () => {
    const { db, edit } = await fixture();
    await db.update(NodeContentTable).set({ contentJson: '{invalid' });
    const { queue } = worker(db);
    await queue.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.getSnapshot().hasError).toBe(true);
    await db.update(NodeContentTable).set({ contentJson: '{}' });
    await edit('repaired');
    queue.request();
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot()).toMatchObject({ phase: 'idle', hasError: false, lastRun: { written: 3 } });
  });

  it('keeps one retry timer and caps repeated failures at 30 seconds', async () => {
    const { db } = await fixture();
    const { queue, repositories } = worker(db, (repository) => ({ ...repository, captureCatalog: async () => { throw new Error('unavailable'); } }));
    await queue.flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay);
      expect(queue.getSnapshot().phase).toBe('failed');
    }
    expect(repositories).toHaveLength(1);
    queue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('force repair revokes an in-flight owner before replacement can commit', async () => {
    const { db, read } = await fixture();
    let invalidate = true;
    let force: () => void = () => {};
    const { queue } = worker(db, (repository) => ({
      ...repository,
      replaceSource: async (prepared) => {
        if (invalidate) { invalidate = false; force(); }
        return repository.replaceSource(prepared);
      },
    }));
    force = () => queue.request(true);
    await queue.flush();
    expect(await read()).toEqual([]);
    expect(queue.getSnapshot().hasError).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ written: 3, reused: 0 });
  });

  it('prunes deletion and processes restored sources even when their body version is unchanged', async () => {
    const { db, read } = await fixture();
    const { queue } = worker(db);
    await queue.flush();
    await db.update(BookNodeTable).set({ deletedAt: NOW }).where(eq(BookNodeTable.id, 'node-0'));
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ prepared: 0, removedSources: 1 });
    expect(await read()).toHaveLength(2);
    await db.update(BookNodeTable).set({ deletedAt: null });
    await queue.flush();
    expect(queue.getSnapshot().lastRun).toMatchObject({ prepared: 1, written: 1, reused: 2 });
    expect(await read()).toHaveLength(3);
  });

  it('new owners repair missing rows even when the previous owner acknowledged every version', async () => {
    const { db, read } = await fixture();
    const first = worker(db);
    await first.queue.flush();
    first.queue.dispose();
    await db.delete(InlineMentionTable);
    const second = worker(db);
    await second.queue.flush();
    expect(second.queue.getSnapshot().lastRun).toMatchObject({ prepared: 3, written: 3 });
    expect(await read()).toHaveLength(3);
  });

  it('rechecks coverage removed by lifecycle cleanup even when source prose is unchanged', async () => {
    const { db, read } = await fixture();
    const { queue } = worker(db);
    await queue.flush();
    await db.delete(InlineMentionTable).where(eq(InlineMentionTable.fromId, 'node-0'));
    queue.request();
    await vi.advanceTimersByTimeAsync(250);
    expect(queue.getSnapshot().lastRun).toMatchObject({ prepared: 1, written: 1, reused: 2 });
    expect(await read()).toHaveLength(3);
  });

  it('disposal cancels scheduled work, releases yields, and prevents late publication', async () => {
    const { db, read } = await fixture(40);
    const { queue, changed } = worker(db);
    const pass = queue.flush();
    await vi.advanceTimersByTimeAsync(0);
    queue.dispose();
    await pass;
    expect(queue.getSnapshot().phase).toBe('disposed');
    expect(changed).not.toHaveBeenCalled();
    expect((await read()).length).toBeLessThan(40);
    expect(vi.getTimerCount()).toBe(0);
    queue.request();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('reference queue runtime wiring', () => {
  it('repairs coverage after a recreated sync runtime even when source notifications were lost', async () => {
    const { db, edit, read } = await fixture();
    await mountService(db);
    await edit('missed-notification');
    events.emit('sync:reference-coverage-invalidated', { projectId: 'other-project' });
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('idle');
    events.emit('sync:reference-coverage-invalidated', { projectId: 'project-a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ capture: 'full', written: 3 });
    expect((await read()).find((row) => row.fromId === 'node-0')!.toId).toBe('missed-notification');
  });

  it('uses complete capture for unknown prose scopes and workspace changes carrying prose hints', async () => {
    const { db } = await fixture();
    await mountService(db);
    for (const event of [
      { projectionImpact: 'prose-only' as const },
      { projectionImpact: 'prose-only' as const, proseDocIds: ['unknown:node-0'] },
      { projectionImpact: 'workspace' as const, proseDocIds: ['node-content:node-0'] },
    ]) {
      events.emit('sync:project-changed', { projectId: 'project-a', ...event });
      await vi.advanceTimersByTimeAsync(250);
      expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ capture: 'full', sources: 3 });
    }
  });
  it('indexes JSON-only patch create and update commits and prunes durable patch deletion', async () => {
    const { db, read } = await fixture();
    await db.insert(BookElementTable).values({ id: 'patch-parent', projectId: 'project-a', name: 'Synthetic parent', createdAt: NOW, updatedAt: NOW });
    await mountService(db);
    const patch = await createElementPatchWithSync({ projectId: 'project-a', elementId: 'patch-parent', contentJson: json('patch-created') });
    await vi.advanceTimersByTimeAsync(250);
    expect((await read()).find((row) => row.fromId === patch.id)!.toId).toBe('patch-created');
    await updateElementPatchWithSync('project-a', patch.id, { contentJson: json('patch-updated') });
    await vi.advanceTimersByTimeAsync(250);
    expect((await read()).find((row) => row.fromId === patch.id)!.toId).toBe('patch-updated');
    await deleteElementPatchWithSync('project-a', patch.id);
    await vi.advanceTimersByTimeAsync(250);
    expect((await read()).some((row) => row.fromId === patch.id)).toBe(false);
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ prepared: 0, removedSources: 1 });
  });
  it('survives immediate release and reattachment without retaining a cancelled startup', async () => {
    const { db } = await fixture();
    const uninstall = installHeadlessDatabaseClient(db, 'synthetic-reference.db');
    cleanups.push(uninstall);
    const abandoned = retainProjectReferenceIndex('project-a');
    abandoned();
    const release = retainProjectReferenceIndex('project-a');
    cleanups.push(release);
    await vi.advanceTimersByTimeAsync(0);
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ written: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a previous database queue even when the next database reuses the project ID', async () => {
    const first = await fixture();
    const second = await fixture();
    let oldInstalled = true;
    const uninstallOld = installHeadlessDatabaseClient(first.db, 'first-synthetic.db');
    cleanups.push(() => { if (oldInstalled) uninstallOld(); });
    const releaseOld = retainProjectReferenceIndex('project-a');
    cleanups.push(releaseOld);
    await vi.advanceTimersByTimeAsync(0);
    await first.edit('old-database-new-body');
    events.emit('sync:project-changed', { projectId: 'project-a', projectionImpact: 'workspace' });
    uninstallOld();
    oldInstalled = false;
    const uninstallNew = installHeadlessDatabaseClient(second.db, 'second-synthetic.db');
    cleanups.push(uninstallNew);
    events.emit('db:ready');
    const releaseNew = retainProjectReferenceIndex('project-a');
    cleanups.push(releaseNew);
    await vi.advanceTimersByTimeAsync(250);
    releaseOld();
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('idle');
    expect((await first.read()).find((row) => row.fromId === 'node-0')!.toId).toBe('seed-target');
    expect((await second.read()).find((row) => row.fromId === 'node-0')!.toId).toBe('seed-target');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one worker across retainers and releases all event listeners and timers', async () => {
    const { db } = await fixture();
    const before = [...events.all].map(([type, handlers]) => [type, handlers.length]);
    const release = await mountService(db);
    const releaseSecond = retainProjectReferenceIndex('project-a');
    release();
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('idle');
    releaseSecond();
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('disposed');
    expect([...events.all].filter(([, handlers]) => handlers.length).map(([type, handlers]) => [type, handlers.length])).toEqual(before.filter(([, count]) => count));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes ordinary authored Yjs only after commit and suppresses faulty observers', async () => {
    const { db, read } = await fixture();
    await mountService(db);
    cleanups.push(onAuthoredChangeCommitted(() => { throw new Error('broken observer'); }));
    const notified = vi.fn();
    cleanups.push(onAuthoredChangeCommitted(notified));
    await appendAuthoredYjsUpdate('project-a', 'node-content:node-0', update('ordinary-durable'));
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified.mock.calls[0]![0].proseDocIds).toEqual(['node-content:node-0']);
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(250);
    expect((await read()).find((row) => row.fromId === 'node-0')!.toId).toBe('ordinary-durable');
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ capture: 'sources', sources: 1, written: 1 });
  });

  it('observes Agent outer commits but not rolled-back Agent savepoints', async () => {
    const { db, read } = await fixture();
    await mountService(db);
    const journal = createTestAgentAuthoredJournal('reference-queue');
    const recorded = vi.fn();
    cleanups.push(onAuthoredChangeCommitted(recorded));
    const commitAgent = async (rollback: boolean) => db.transaction(async (outer) => {
      await outer.transaction(async (tx) => {
        const bytes = update(rollback ? 'rolled-back-agent' : 'committed-agent');
        await createYjsRepository(tx).appendUpdate('node-content:node-0', bytes, { kind: 'agent' });
        const changes = journal.createChangeSet();
        appendYjsUpdateMutation(changes, 'node-content:node-0', bytes);
        await journal.record(tx, { projectId: 'project-a', changes, committedAt: NOW });
        expect(recorded).not.toHaveBeenCalled();
        if (rollback) throw new Error('agent rollback');
      });
    });
    await expect(commitAgent(true)).rejects.toThrow('agent rollback');
    expect(recorded).not.toHaveBeenCalled();
    await commitAgent(false);
    expect(recorded).toHaveBeenCalledTimes(1);
    expect(recorded.mock.calls[0]![0]).toMatchObject({ command: 'agent.write', projectId: 'project-a', proseDocIds: ['node-content:node-0'] });
    await vi.advanceTimersByTimeAsync(250);
    expect((await read()).find((row) => row.fromId === 'node-0')!.toId).toBe('committed-agent');
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ capture: 'sources', sources: 1 });
  });

  it('handles remote prose without a workspace refresh, and restores force complete repair', async () => {
    const { db, read } = await fixture();
    await mountService(db);
    await createYjsRepository(db).appendUpdate('node-content:node-0', update('remote-durable'), { kind: 'remote' });
    events.emit('sync:project-changed', { projectId: 'another-project', projectionImpact: 'workspace' });
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('idle');
    events.emit('sync:project-changed', { projectId: 'project-a', projectionImpact: 'prose-only', proseDocIds: ['node-content:node-0'] });
    await vi.advanceTimersByTimeAsync(250);
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ capture: 'sources', sources: 1, prepared: 1, written: 1, reused: 0 });
    await db.delete(InlineMentionTable);
    events.emit('sync:projects-restored', { projectIds: ['project-a'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(await read()).toHaveLength(3);
    expect(getProjectReferenceIndexSnapshot('project-a').lastRun).toMatchObject({ written: 3, reused: 0 });
  });

  it('status observation does not retain a worker and manual retry repairs a failed source', async () => {
    const { db, edit } = await fixture();
    const changes = vi.fn();
    cleanups.push(subscribeProjectReferenceIndex('project-a', changes));
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('disposed');
    const release = await mountService(db);
    await db.update(NodeContentTable).set({ contentJson: '{invalid' }).where(eq(NodeContentTable.nodeId, 'node-0'));
    events.emit('sync:project-changed', { projectId: 'project-a', projectionImpact: 'workspace' });
    await vi.advanceTimersByTimeAsync(250);
    expect(getProjectReferenceIndexSnapshot('project-a').hasError).toBe(true);
    await edit('repaired-manually');
    retryProjectReferenceIndex('project-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(getProjectReferenceIndexSnapshot('project-a').hasError).toBe(false);
    expect(changes).toHaveBeenCalled();
    release();
    expect(getProjectReferenceIndexSnapshot('project-a').phase).toBe('disposed');
    expect(vi.getTimerCount()).toBe(0);
  });
});
