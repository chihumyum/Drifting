import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

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
  const repo: YjsRepository = {
    listUpdates: vi.fn(async () => options.updates ?? []),
    listDocIds: vi.fn(async () => []),
    appendUpdate: vi.fn(async () => nextId++),
    getSnapshot: vi.fn(async () => {
      if (options.snapshotError) throw options.snapshotError;
      return null;
    }),
    upsertSnapshot: vi.fn(async () => undefined),
    hasDocState: vi.fn(async () => false),
    maxUpdateId: vi.fn(async () => 999_999),
    deleteUpdatesUpTo: vi.fn(async () => 0),
  };
  const dependencies: YjsDocumentSessionDependencies = {
    initDatabase: vi.fn(async () => undefined),
    createRepository: vi.fn(() => repo),
    isSyncEnabled: vi.fn(() => false),
    resetCursor: vi.fn(async () => undefined),
    pullUpdates: vi.fn(async () => undefined),
    compactUpdatesAfterSnapshot: vi.fn(async () => 0),
    captureSnapshotHistory: vi.fn(),
    queueMicrotask,
  };
  return { repo, dependencies, registry: new YjsDocumentSessionRegistry(dependencies) };
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
    const firstSession = registry.get('node-content:shared', 'user-1');
    const secondSession = registry.get('node-content:shared', 'user-1');
    expect(secondSession).toBe(firstSession);

    const releases = [firstSession.retain(), secondSession.retain()];
    await firstSession.waitUntilLoaded();
    expect(dependencies.initDatabase).toHaveBeenCalledOnce();
    expect(repo.listUpdates).toHaveBeenCalledOnce();

    firstSession.ydoc.getText('body').insert(0, 'alpha');
    secondSession.ydoc.getText('body').insert(5, ' beta');
    await firstSession.flushPendingWrites();

    releases[first]();
    await Promise.resolve();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();

    releases[last]();
    await settleFinalClose(firstSession);

    expect(repo.upsertSnapshot).toHaveBeenCalledOnce();
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
    const session = registry.get('node-content:corrupt', 'user-1');
    const release = session.retain();

    await expect(session.waitUntilLoaded()).rejects.toBeInstanceOf(Error);
    expect(session.getSnapshot().isReady).toBe(false);
    expect(session.getSnapshot().error).toBeInstanceOf(Error);

    // Even a direct mutation of the partially replayed object has no writer;
    // UI consumers never receive it as an editable/ready document.
    session.ydoc.getText('body').insert(0, 'must-not-persist');
    release();
    await settleFinalClose(session);

    expect(repo.appendUpdate).not.toHaveBeenCalled();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    expect(repo.deleteUpdatesUpTo).not.toHaveBeenCalled();
    expect(dependencies.compactUpdatesAfterSnapshot).not.toHaveBeenCalled();
    expect(repo.maxUpdateId).not.toHaveBeenCalled();
  });

  it('surfaces SQLite load failures without creating an editable session', async () => {
    const { registry, repo } = createHarness({ snapshotError: new Error('sqlite unavailable') });
    const session = registry.get('node-content:db-error', 'user-1');
    const release = session.retain();

    await expect(session.waitUntilLoaded()).rejects.toThrow('sqlite unavailable');
    expect(session.getSnapshot()).toMatchObject({
      isReady: false,
      hasLocalState: false,
    });
    expect(session.getSnapshot().error?.message).toBe('sqlite unavailable');

    release();
    await settleFinalClose(session);
    expect(repo.appendUpdate).not.toHaveBeenCalled();
    expect(repo.upsertSnapshot).not.toHaveBeenCalled();
    expect(repo.deleteUpdatesUpTo).not.toHaveBeenCalled();
  });

  it('does not persist a blank snapshot when legacy decoding fails', async () => {
    const { registry, repo, dependencies } = createHarness();
    const session = registry.get('node-content:legacy-error', 'user-1');
    const release = session.retain(async () => {
      throw new Error('invalid legacy prose');
    });

    await expect(session.waitUntilLoaded()).rejects.toThrow('invalid legacy prose');
    expect(session.getSnapshot().isReady).toBe(false);
    expect(session.getSnapshot().error?.message).toBe('invalid legacy prose');

    release();
    await settleFinalClose(session);
    expect(repo.appendUpdate).not.toHaveBeenCalled();
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

    const session = registry.get('node-content:loading-close', 'user-1');
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
