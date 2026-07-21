import loglevel from 'loglevel';
import * as Y from 'yjs';

import { isSyncEnabled } from '../lib/config';
import { initDatabase } from '../lib/db';
import { createYjsRepository, type YjsRepository } from '../sqlite-repo/yjs-repo';
import { maybeCaptureSnapshotHistory } from './snapshot-history.service';
import {
  compactUpdatesAfterSnapshot,
  pullUpdates,
  resetCursor,
} from './yjs-sync.service';

const log = loglevel.getLogger('yjs-document-session');
log.setLevel(loglevel.levels.WARN);

const SNAPSHOT_EVERY_UPDATES = 50;

export type YjsDocumentSeed = (
  apply: (mutator: (ydoc: Y.Doc) => void) => void,
) => Promise<void> | void;

export interface YjsDocumentSessionSnapshot {
  isReady: boolean;
  hasLocalState: boolean;
  error: Error | null;
}

export interface YjsDocumentSessionDependencies {
  initDatabase: (userId: string) => Promise<unknown>;
  createRepository: () => YjsRepository;
  isSyncEnabled: () => boolean;
  resetCursor: (docId: string) => Promise<void>;
  pullUpdates: (docId: string, ydoc: Y.Doc, repo: YjsRepository) => Promise<void>;
  compactUpdatesAfterSnapshot: (
    docId: string,
    snapshotCoveredId: number,
    repo: YjsRepository,
  ) => Promise<number>;
  captureSnapshotHistory: (
    docId: string,
    stateBlob: Uint8Array,
    reason?: 'periodic' | 'close' | 'restore',
  ) => void;
  queueMicrotask: (callback: () => void) => void;
}

/**
 * Keep the browser's Window receiver when this scheduler is stored on the
 * dependency object. WebKit brand-checks Window.queueMicrotask, so passing the
 * native function through directly and invoking it as an object method throws.
 */
export function scheduleMicrotask(callback: () => void): void {
  globalThis.queueMicrotask(callback);
}

const defaultDependencies: YjsDocumentSessionDependencies = {
  initDatabase,
  createRepository: createYjsRepository,
  isSyncEnabled,
  resetCursor,
  pullUpdates,
  compactUpdatesAfterSnapshot,
  captureSnapshotHistory: maybeCaptureSnapshotHistory,
  queueMicrotask: scheduleMicrotask,
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * One process-wide persistence owner for one logical Yjs document.
 *
 * Every React consumer of a docId shares this instance: the Y.Doc, the first
 * load, the SQLite append queue and the compaction coverage cursor. The final
 * consumer queues exactly one close snapshot; earlier consumers only release
 * their reference and can never overwrite a sibling editor's state.
 */
export class YjsDocumentSession {
  readonly ydoc = new Y.Doc();

  private readonly repo: YjsRepository;
  private readonly listeners = new Set<() => void>();
  private snapshot: YjsDocumentSessionSnapshot = {
    isReady: false,
    hasLocalState: false,
    error: null,
  };
  private status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private loadPromise: Promise<void> | null = null;
  private refCount = 0;
  private releaseGeneration = 0;
  private closing = false;
  private updateHandlerAttached = false;
  private localUpdatesSinceSnapshot = 0;
  /** Highest SQLite update id successfully replayed or appended into this Y.Doc. */
  private snapshotCoveredUpdateId = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeErrors: unknown[] = [];

  constructor(
    readonly docId: string,
    readonly userId: string,
    private readonly dependencies: YjsDocumentSessionDependencies,
    private readonly dispose: (session: YjsDocumentSession) => void,
  ) {
    this.repo = dependencies.createRepository();
  }

  getSnapshot = (): YjsDocumentSessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Retain this shared document. The first consumer owns the single load. */
  retain(seedFromLegacy?: YjsDocumentSeed): () => void {
    this.refCount += 1;
    this.releaseGeneration += 1;

    if (this.closing) {
      // A consumer can remount while the deferred close snapshot is draining.
      // Re-attach immediately; any new update is queued after that snapshot.
      this.closing = false;
      if (this.status === 'ready') this.attachUpdateHandler();
    }

    if (this.status === 'idle') this.startLoad(seedFromLegacy);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refCount = Math.max(0, this.refCount - 1);
      if (this.refCount !== 0) return;

      const generation = ++this.releaseGeneration;
      this.dependencies.queueMicrotask(() => {
        if (this.refCount !== 0 || generation !== this.releaseGeneration) return;
        this.beginFinalClose(generation);
      });
    };
  }

  /** Resolves when the shared initial load finishes; rejects on fail-closed load. */
  async waitUntilLoaded(): Promise<void> {
    if (this.status === 'idle') {
      throw new Error(`Yjs document ${this.docId} has not been retained`);
    }
    await this.loadPromise;
  }

  /** Wait until every queued local update has reached SQLite. */
  async flushPendingWrites(): Promise<void> {
    let observed: Promise<void>;
    do {
      observed = this.writeQueue;
      await observed;
    } while (observed !== this.writeQueue);

    if (this.writeErrors.length > 0) {
      const failures = this.writeErrors;
      this.writeErrors = [];
      throw new AggregateError(
        failures,
        `${failures.length} Yjs SQLite write(s) failed to persist`,
      );
    }
  }

  /** Persist a full snapshot behind every update already emitted by the Y.Doc. */
  async flushLocalState(): Promise<void> {
    if (this.closing) {
      await this.flushPendingWrites();
      return;
    }
    if (this.status === 'error') {
      throw this.snapshot.error ?? new Error(`Yjs document ${this.docId} failed to load`);
    }
    if (this.status !== 'ready') {
      await this.waitUntilLoaded();
      if (!this.snapshot.isReady) {
        throw this.snapshot.error ?? new Error('Yjs document not ready');
      }
    }

    const fullState = Y.encodeStateAsUpdate(this.ydoc);
    this.enqueueWrite(() => this.persistSnapshotAndCompact(fullState));
    await this.flushPendingWrites();
  }

  /**
   * Lifecycle-safe drain used while views are being unmounted or a database is
   * switching. A failed initial load owns no editable changes, so it waits for
   * the read to settle but does not turn corruption into a logout deadlock.
   */
  async flushForLifecycle(): Promise<void> {
    if (this.status === 'loading') {
      try {
        await this.waitUntilLoaded();
      } catch {
        return;
      }
    }
    if (this.status === 'error') return;
    if (this.closing) {
      await this.flushPendingWrites();
      return;
    }
    await this.flushLocalState();
  }

  private publish(next: YjsDocumentSessionSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  private startLoad(seedFromLegacy?: YjsDocumentSeed): void {
    this.status = 'loading';
    this.publish({ isReady: false, hasLocalState: false, error: null });

    const operation = this.load(seedFromLegacy).catch((error: unknown) => {
      const normalized = normalizeError(error);
      this.status = 'error';
      this.publish({ isReady: false, hasLocalState: false, error: normalized });
      log.error(`[yjs session] failed to load doc ${this.docId}:`, normalized);
      throw normalized;
    });
    // The UI observes the error through getSnapshot(); keep a handled branch so
    // an effect-triggered load never creates an unhandled rejection.
    void operation.catch(() => undefined);
    this.loadPromise = operation;
  }

  private async load(seedFromLegacy?: YjsDocumentSeed): Promise<void> {
    await this.dependencies.initDatabase(this.userId);

    const snapshot = await this.repo.getSnapshot(this.docId);
    if (snapshot) Y.applyUpdate(this.ydoc, snapshot.stateBlob, 'load');

    const updates = await this.repo.listUpdates(this.docId);
    for (const item of updates) {
      Y.applyUpdate(this.ydoc, item.updateBlob, 'load');
      // Advance only after this exact row was decoded and applied successfully.
      this.snapshotCoveredUpdateId = Math.max(this.snapshotCoveredUpdateId, item.id);
    }

    const hadAnything = Boolean(snapshot) || updates.length > 0;

    if (!hadAnything) {
      await this.dependencies.resetCursor(this.docId);

      if (this.dependencies.isSyncEnabled()) {
        try {
          await this.dependencies.pullUpdates(this.docId, this.ydoc, this.repo);
        } catch (error) {
          // A network failure does not invalidate an otherwise valid local
          // load. The legacy seed remains the offline recovery path.
          log.warn(`[yjs session] initial pull failed for ${this.docId}:`, error);
        }
      }

      if (seedFromLegacy && this.ydoc.getXmlFragment('default').length === 0) {
        await seedFromLegacy((mutator) => {
          this.ydoc.transact(() => {
            if (this.ydoc.getXmlFragment('default').length > 0) return;
            mutator(this.ydoc);
          }, 'seed');
        });
        const fullState = Y.encodeStateAsUpdate(this.ydoc);
        await this.repo.upsertSnapshot(this.docId, fullState);
      }
    } else if (this.dependencies.isSyncEnabled()) {
      try {
        await this.dependencies.pullUpdates(this.docId, this.ydoc, this.repo);
      } catch (error) {
        // Existing durable local state remains safe to edit while offline.
        log.warn(`[yjs session] catch-up pull failed for ${this.docId}:`, error);
      }
    }

    this.status = 'ready';
    if (!this.closing && this.refCount > 0) this.attachUpdateHandler();
    this.publish({
      isReady: true,
      hasLocalState: hadAnything || Boolean(seedFromLegacy),
      error: null,
    });
  }

  private readonly handleUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'load') return;

    const isLocalEdit = origin !== 'remote' && origin !== 'seed' && origin !== 'restore';
    const updateCopy = new Uint8Array(update);

    this.enqueueWrite(async () => {
      if (isLocalEdit) {
        const persistedId = await this.repo.appendUpdate(this.docId, updateCopy);
        // This is the only safe compaction coverage source: the update was both
        // applied to this unique Y.Doc and durably appended by this queue.
        this.snapshotCoveredUpdateId = Math.max(
          this.snapshotCoveredUpdateId,
          persistedId,
        );
      }
      this.localUpdatesSinceSnapshot += 1;

      if (this.localUpdatesSinceSnapshot >= SNAPSHOT_EVERY_UPDATES) {
        await this.persistSnapshotAndCompact(Y.encodeStateAsUpdate(this.ydoc));
        this.localUpdatesSinceSnapshot = 0;
      }
    });
  };

  private attachUpdateHandler(): void {
    if (this.updateHandlerAttached) return;
    this.ydoc.on('update', this.handleUpdate);
    this.updateHandlerAttached = true;
  }

  private detachUpdateHandler(): void {
    if (!this.updateHandlerAttached) return;
    this.ydoc.off('update', this.handleUpdate);
    this.updateHandlerAttached = false;
  }

  private enqueueWrite(task: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(task).catch((error) => {
      this.writeErrors.push(error);
      log.error(`[yjs session] write failed for ${this.docId}:`, error);
    });
  }

  private async persistSnapshotAndCompact(
    fullState: Uint8Array,
    reason: 'periodic' | 'close' = 'periodic',
  ): Promise<void> {
    // Read the session-owned cursor inside the serial queue. It can only name
    // rows that this same Y.Doc successfully replayed or appended before this
    // exact fullState capture was queued.
    const coveredId = this.snapshotCoveredUpdateId;
    await this.repo.upsertSnapshot(this.docId, fullState);
    this.dependencies.captureSnapshotHistory(this.docId, fullState, reason);
    await this.dependencies.compactUpdatesAfterSnapshot(this.docId, coveredId, this.repo);
  }

  private beginFinalClose(generation: number): void {
    if (this.refCount !== 0 || generation !== this.releaseGeneration || this.closing) return;
    this.closing = true;
    this.detachUpdateHandler();

    if (this.status === 'ready') {
      const fullState = Y.encodeStateAsUpdate(this.ydoc);
      this.enqueueWrite(() => this.persistSnapshotAndCompact(fullState, 'close'));
    }

    const finalize = async () => {
      // A loading session must settle before destruction, but a failed load is
      // never allowed to queue a close snapshot or compaction.
      if (this.status === 'loading') {
        try {
          await this.loadPromise;
        } catch {
          // The error is already published; teardown remains read-only.
        }
      }
      // Wait for disposal without consuming queued failures. The lifecycle
      // registration drains flushLocalState() in the adjacent cleanup and is
      // responsible for surfacing an AggregateError to database-switch logic.
      await this.writeQueue;

      if (this.refCount !== 0 || generation !== this.releaseGeneration || !this.closing) {
        return;
      }
      this.dispose(this);
      this.ydoc.destroy();
    };
    void finalize();
  }
}

export class YjsDocumentSessionRegistry {
  private readonly sessions = new Map<string, YjsDocumentSession>();

  constructor(private readonly dependencies: YjsDocumentSessionDependencies = defaultDependencies) {}

  get(docId: string, userId: string): YjsDocumentSession {
    const existing = this.sessions.get(docId);
    if (existing) {
      if (existing.userId !== userId) {
        throw new Error(
          `Yjs document ${docId} is still mounted for another user; database switch was not quiesced`,
        );
      }
      return existing;
    }

    const created = new YjsDocumentSession(docId, userId, this.dependencies, (session) => {
      if (this.sessions.get(docId) === session) this.sessions.delete(docId);
    });
    this.sessions.set(docId, created);
    return created;
  }
}

const processYjsDocumentSessions = new YjsDocumentSessionRegistry();

export function getYjsDocumentSession(docId: string, userId: string): YjsDocumentSession {
  return processYjsDocumentSessions.get(docId, userId);
}
