import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { createPersistedYjsUpdateOrigin } from '../lib/yjs-persistence-origin';
import type { YjsRepository, YjsUpdateRow } from '../sqlite-repo/yjs-repo';
import {
  scheduleMicrotask,
  YjsDocumentSessionRegistry,
  type YjsDocumentSessionDependencies,
} from './yjs-document-session';

function yjsUpdate(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('body').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function createHarness(options: { updates?: YjsUpdateRow[]; snapshotError?: Error } = {}) {
  let nextId = 11;
  const storedUpdates = [...(options.updates ?? [])];
  const persistUpdate = (docId: string, updateBlob: Uint8Array, id = nextId++): number => {
    storedUpdates.push({
      id,
      docId,
      updateBlob: new Uint8Array(updateBlob),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    storedUpdates.sort((left, right) => left.id - right.id);
    nextId = Math.max(nextId, id + 1);
    return id;
  };
  const repo: YjsRepository = {
    listUpdates: vi.fn(async (docId, sinceId) =>
      storedUpdates.filter((row) =>
        row.docId === docId && (sinceId === undefined || row.id > sinceId),
      )),
    listDocIds: vi.fn(async () => []),
    appendUpdate: vi.fn(async (docId, update) => persistUpdate(docId, update)),
    appendUpdateCas: vi.fn(async (docId, update, expectedRevision) => ({
      updateId: persistUpdate(docId, update),
      previousRevision: expectedRevision,
      revision: expectedRevision + 1,
    })),
    getSnapshot: vi.fn(async () => {
      if (options.snapshotError) throw options.snapshotError;
      return null;
    }),
    upsertSnapshot: vi.fn(async () => undefined),
    hasDocState: vi.fn(async () => false),
    getRevision: vi.fn(async () => 0),
    listRevisionProvenance: vi.fn(async () => []),
    maxUpdateId: vi.fn(async () => 999_999),
    deleteUpdatesUpTo: vi.fn(async () => 0),
  };
  const dependencies: YjsDocumentSessionDependencies = {
    initDatabase: vi.fn(async () => undefined),
    createRepository: vi.fn(() => repo),
    appendAuthoredUpdate: vi.fn(async (_projectId, docId, update) => ({
      updateId: persistUpdate(docId, update),
    })),
    compactUpdatesAfterSnapshot: vi.fn(async () => 0),
    captureSnapshotHistory: vi.fn(),
    queueMicrotask,
  };
  return {
    repo,
    dependencies,
    persistUpdate,
    registry: new YjsDocumentSessionRegistry(dependencies),
  };
}

async function settleFinalClose(session: {
  flushPendingWrites: () => Promise<void>;
}): Promise<void> {
  // First microtask starts the deferred final close; its snapshot then drains
  // through the same queue observed here.
  await Promise.resolve();
  await session.flushPendingWrites();
  await Promise.resolve();
}

describe('YjsDocumentSessionRegistry', () => {
  it('does not append an update that an atomic coordinator already persisted', async () => {
    const { dependencies, registry } = createHarness();
    const session = registry.get('project-1', 'node-content:persisted-agent', 'user-1');
    const release = session.retain();
    await session.waitUntilLoaded();

    Y.applyUpdate(
      session.ydoc,
      yjsUpdate('already durable'),
      createPersistedYjsUpdateOrigin(
        73,
        'yjs-prose:command-persisted:forward',
      ),
    );
    await session.flushPendingWrites();

    expect(dependencies.appendAuthoredUpdate).not.toHaveBeenCalled();
    release();
    await settleFinalClose(session);
  });

  it('preserves the Window receiver for WebKit queueMicrotask', async () => {
    const nativeQueueMicrotask = globalThis.queueMicrotask;
    const callback = vi.fn();
    let usedWindowReceiver = false;

    vi.stubGlobal('queueMicrotask', function strictWindowQueueMicrotask(
      this: typeof globalThis,
      queuedCallback: () => void,
    ) {
      usedWindowReceiver = this === globalThis;
      if (!usedWindowReceiver) {
        throw new TypeError('Can only call Window.queueMicrotask on instances of Window');
      }
      nativeQueueMicrotask(queuedCallback);
    });

    try {
      const dependencies = { queueMicrotask: scheduleMicrotask };
      dependencies.queueMicrotask(callback);
      await new Promise<void>((resolve) => nativeQueueMicrotask(resolve));

      expect(usedWindowReceiver).toBe(true);
      expect(callback).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['first mount closes first', 0, 1],
    ['second mount closes first', 1, 0],
  ])('shares one document and persists only after the final release: %s', async (_name, first, last) => {
    const { registry, repo, dependencies } = createHarness();
    const firstSession = registry.get('project-1', 'node-content:shared', 'user-1');
    const secondSession = registry.get('project-1', 'node-content:shared', 'user-1');
    expect(secondSession).toBe(firstSession);

    const releases = [firstSession.retain(), secondSession.retain()];
    await firstSession.waitUntilLoaded();
    expect(dependencies.initDatabase).toHaveBeenCalledOnce();
    expect(repo.listUpdates).toHaveBeenCalledOnce();

    firstSession.ydoc.getText('body').insert(0, 'alpha');
    secondSession.ydoc.getText('body').insert(5, ' beta');
    await firstSession.flushPendingWrites();

    expect(dependencies.appendAuthoredUpdate).toHaveBeenCalledTimes(2);
    expect(dependencies.appendAuthoredUpdate).toHaveBeenNthCalledWith(
      1,
      'project-1',
      'node-content:shared',
      expect.any(Uint8Array),
      { kind: 'user' },
    );

    releases[first]();
    await Promise.resolve();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();

    releases[last]();
    await settleFinalClose(firstSession);

    expect(repo.upsertSnapshot).toHaveBeenCalledOnce();
    expect(repo.upsertSnapshot).toHaveBeenCalledWith(
      'node-content:shared',
      expect.any(Uint8Array),
      { advanceRevision: false },
    );
    const persisted = new Y.Doc();
    Y.applyUpdate(
      persisted,
      vi.mocked(repo.upsertSnapshot).mock.calls[0][1],
    );
    expect(persisted.getText('body').toString()).toBe('alpha beta');
    expect(dependencies.compactUpdatesAfterSnapshot).toHaveBeenCalledWith(
      'node-content:shared',
      12,
      repo,
    );
    // Compaction coverage is session-owned; querying a global maximum could
    // include rows absent from this captured state.
    expect(repo.maxUpdateId).not.toHaveBeenCalled();
  });

  it('journals a contentJson seed before its snapshot can become a compaction point', async () => {
    const { registry, repo, dependencies } = createHarness();
    const session = registry.get('project-seed', 'node-content:seeded', 'user-1');
    const release = session.retain(async (apply) => {
      apply((doc) => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText('Seeded prose')]);
        doc.getXmlFragment('default').insert(0, [paragraph]);
      });
    });

    await session.waitUntilLoaded();

    expect(dependencies.appendAuthoredUpdate).toHaveBeenCalledOnce();
    expect(dependencies.appendAuthoredUpdate).toHaveBeenCalledWith(
      'project-seed',
      'node-content:seeded',
      expect.any(Uint8Array),
      { kind: 'system' },
    );
    expect(repo.upsertSnapshot).toHaveBeenCalledOnce();
    expect(repo.upsertSnapshot).toHaveBeenCalledWith(
      'node-content:seeded',
      expect.any(Uint8Array),
      { advanceRevision: false },
    );
    expect(
      vi.mocked(dependencies.appendAuthoredUpdate).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(repo.upsertSnapshot).mock.invocationCallOrder[0]);

    const journaled = new Y.Doc();
    Y.applyUpdate(
      journaled,
      vi.mocked(dependencies.appendAuthoredUpdate).mock.calls[0][2],
    );
    expect(journaled.getXmlFragment('default').toString()).toContain('Seeded prose');
    journaled.destroy();

    release();
    await settleFinalClose(session);
    expect(dependencies.compactUpdatesAfterSnapshot).toHaveBeenCalledWith(
      'node-content:seeded',
      11,
      repo,
    );
  });

  it('does not echo a remote update into a new authored journal entry', async () => {
    const { registry, dependencies } = createHarness();
    const session = registry.get('project-1', 'node-content:remote', 'user-1');
    const release = session.retain();
    await session.waitUntilLoaded();

    Y.applyUpdate(session.ydoc, yjsUpdate('from another writer'), 'remote');
    await session.flushPendingWrites();

    expect(dependencies.appendAuthoredUpdate).not.toHaveBeenCalled();
    release();
    await settleFinalClose(session);
  });

  it('replays a lower remote row before advancing coverage to a later persisted live update', async () => {
    const { registry, repo, dependencies, persistUpdate } = createHarness();
    const docId = 'node-content:remote-before-local';
    const session = registry.get('project-1', docId, 'user-1');
    const release = session.retain();
    await session.waitUntilLoaded();

    const remote = yjsUpdate('remote');
    const local = yjsUpdate('local');
    persistUpdate(docId, remote, 11);
    persistUpdate(docId, local, 12);

    // This is the exact race exercised by an Agent/local coordinator: N+2 is
    // merged into the editor after its transaction commits while the N+1
    // remote post-commit callback is still pending.
    Y.applyUpdate(
      session.ydoc,
      local,
      createPersistedYjsUpdateOrigin(12, 'yjs-prose:local-n-plus-two'),
    );
    await session.flushLocalState();

    expect(dependencies.appendAuthoredUpdate).not.toHaveBeenCalled();
    expect(dependencies.compactUpdatesAfterSnapshot).toHaveBeenCalledWith(docId, 12, repo);
    const persisted = new Y.Doc();
    const snapshotCalls = vi.mocked(repo.upsertSnapshot).mock.calls;
    Y.applyUpdate(persisted, snapshotCalls[snapshotCalls.length - 1]![1]);
    expect(persisted.getText('body').toString()).toContain('remote');
    expect(persisted.getText('body').toString()).toContain('local');
    persisted.destroy();

    release();
    await settleFinalClose(session);
  });

  it('cannot snapshot or compact a local update until its journal transaction commits', async () => {
    const { registry, repo, dependencies, persistUpdate } = createHarness();
    let resolveJournal!: (value: { updateId: number }) => void;
    vi.mocked(dependencies.appendAuthoredUpdate).mockImplementationOnce(
      (_projectId, docId, update) => new Promise((resolve) => {
        resolveJournal = ({ updateId }) => {
          persistUpdate(docId, update, updateId);
          resolve({ updateId });
        };
      }),
    );
    const session = registry.get('project-1', 'node-content:barrier', 'user-1');
    const release = session.retain();
    await session.waitUntilLoaded();

    session.ydoc.getText('body').insert(0, 'must be journaled first');
    const flush = session.flushLocalState();
    await Promise.resolve();
    await Promise.resolve();

    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    expect(dependencies.compactUpdatesAfterSnapshot).not.toHaveBeenCalled();

    resolveJournal({ updateId: 44 });
    await flush;
    expect(repo.upsertSnapshot).toHaveBeenCalledOnce();
    expect(dependencies.compactUpdatesAfterSnapshot).toHaveBeenCalledWith(
      'node-content:barrier',
      44,
      repo,
    );

    release();
    await settleFinalClose(session);
  });

  it('rejects reusing one docId under a different project', async () => {
    const { registry } = createHarness();
    const session = registry.get('project-a', 'node-content:ambiguous', 'user-1');
    const release = session.retain();
    await session.waitUntilLoaded();

    expect(() =>
      registry.get('project-b', 'node-content:ambiguous', 'user-1'),
    ).toThrow(/another project/u);

    release();
    await settleFinalClose(session);
  });

  it('fails closed after a replay error and performs zero writes on release', async () => {
    const valid = yjsUpdate('replayed-before-corruption');
    const updates: YjsUpdateRow[] = [
      {
        id: 3,
        docId: 'node-content:corrupt',
        updateBlob: valid,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 4,
        docId: 'node-content:corrupt',
        updateBlob: new Uint8Array([255]),
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ];
    const { registry, repo, dependencies } = createHarness({ updates });
    const session = registry.get('project-1', 'node-content:corrupt', 'user-1');
    const release = session.retain();

    await expect(session.waitUntilLoaded()).rejects.toBeInstanceOf(Error);
    expect(session.getSnapshot().isReady).toBe(false);
    expect(session.getSnapshot().error).toBeInstanceOf(Error);

    // Even a direct mutation of the partially replayed object has no writer;
    // UI consumers never receive it as an editable/ready document.
    session.ydoc.getText('body').insert(0, 'must-not-persist');
    release();
    await settleFinalClose(session);

    expect(dependencies.appendAuthoredUpdate).not.toHaveBeenCalled();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    expect(repo.deleteUpdatesUpTo).not.toHaveBeenCalled();
    expect(dependencies.compactUpdatesAfterSnapshot).not.toHaveBeenCalled();
    expect(repo.maxUpdateId).not.toHaveBeenCalled();
  });

  it('surfaces SQLite load failures without creating an editable session', async () => {
    const { registry, repo, dependencies } = createHarness({
      snapshotError: new Error('sqlite unavailable'),
    });
    const session = registry.get('project-1', 'node-content:db-error', 'user-1');
    const release = session.retain();

    await expect(session.waitUntilLoaded()).rejects.toThrow('sqlite unavailable');
    expect(session.getSnapshot()).toMatchObject({
      isReady: false,
      hasLocalState: false,
    });
    expect(session.getSnapshot().error?.message).toBe('sqlite unavailable');

    release();
    await settleFinalClose(session);
    expect(dependencies.appendAuthoredUpdate).not.toHaveBeenCalled();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    expect(repo.deleteUpdatesUpTo).not.toHaveBeenCalled();
  });

  it('does not persist a blank snapshot when seed decoding fails', async () => {
    const { registry, repo, dependencies } = createHarness();
    const session = registry.get('project-1', 'node-content:seed-error', 'user-1');
    const release = session.retain(async () => {
      throw new Error('invalid seed prose');
    });

    await expect(session.waitUntilLoaded()).rejects.toThrow('invalid seed prose');
    expect(session.getSnapshot().isReady).toBe(false);
    expect(session.getSnapshot().error?.message).toBe('invalid seed prose');

    release();
    await settleFinalClose(session);
    expect(dependencies.appendAuthoredUpdate).not.toHaveBeenCalled();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    expect(dependencies.compactUpdatesAfterSnapshot).not.toHaveBeenCalled();
  });

  it('keeps lifecycle teardown pending until an in-flight load settles', async () => {
    const { registry, dependencies } = createHarness();
    let releaseDatabase!: () => void;
    const databaseBarrier = new Promise<void>((resolve) => {
      releaseDatabase = resolve;
    });
    vi.mocked(dependencies.initDatabase).mockImplementationOnce(() => databaseBarrier);

    const session = registry.get('project-1', 'node-content:loading-close', 'user-1');
    const release = session.retain();
    const lifecycleFlush = session.flushForLifecycle();
    release();

    let settled = false;
    void lifecycleFlush.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseDatabase();
    await lifecycleFlush;
    expect(settled).toBe(true);
    expect(session.getSnapshot().isReady).toBe(true);
  });
});
