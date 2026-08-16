import loglevel from 'loglevel';
import * as Y from 'yjs';

import { initDatabase } from '../lib/db';
import { readPersistedYjsUpdateOrigin } from '../lib/yjs-persistence-origin';
import { createYjsRepository, type YjsRepository } from '../sqlite-repo/yjs-repo';
import {
  appendAuthoredYjsUpdate,
  type AuthoredYjsUpdateWriter,
} from '../sync/journal/yjs-update';
import { maybeCaptureSnapshotHistory } from './snapshot-history.service';
import { compactUpdatesAfterSnapshot } from './yjs-local-durability.service';

const log = loglevel.getLogger('yjs-document-session');
log.setLevel(loglevel.levels.WARN);

const SNAPSHOT_EVERY_UPDATES = 50;
const PERSISTED_TAIL_ORIGIN = Symbol('drifting.persisted-yjs-tail');

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
  appendAuthoredUpdate: AuthoredYjsUpdateWriter;
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
  appendAuthoredUpdate: appendAuthoredYjsUpdate,
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
    readonly projectId: string,
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
  retain(seedFromContentJson?: YjsDocumentSeed): () => void {
    this.refCount += 1;
    this.releaseGeneration += 1;

    if (this.closing) {
      // A consumer can remount while the deferred close snapshot is draining.
      // Re-attach immediately; any new update is queued after that snapshot.
      this.closing = false;
      if (this.status === 'ready') this.attachUpdateHandler();
    }

    if (this.status === 'idle') this.startLoad(seedFromContentJson);

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

    this.enqueueWrite(async () => {
      // A remote reducer can commit between the editor's initial load and this
      // durability barrier. Reconcile the durable tail first, then capture the
      // state inside the same serial queue so compaction can never cover a row
      // that this live Y.Doc has not actually absorbed.
      await this.applyPersistedTail();
      await this.persistSnapshotAndCompact(Y.encodeStateAsUpdate(this.ydoc));
    });
    await this.flushPendingWrites();
  }

  /**
   * Merge every SQLite update newer than this session's proven coverage.
   *
   * SyncEngine calls this only after its reducer transaction commits. The
   * serialized tail read also closes the race where a durable remote row N+1
   * lands immediately before an already-persisted Agent/local row N+2 is
   * applied to the live document. Coverage advances row-by-row only after the
   * exact stored bytes have been accepted by Yjs.
   */
  async reconcilePersistedUpdates(): Promise<void> {
    if (this.status === 'idle') return;
    if (this.status === 'loading') await this.waitUntilLoaded();
    if (this.status === 'error') {
      throw this.snapshot.error ?? new Error(`Yjs document ${this.docId} failed to load`);
    }
    this.enqueueWrite(() => this.applyPersistedTail());
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

  private startLoad(seedFromContentJson?: YjsDocumentSeed): void {
    this.status = 'loading';
    this.publish({ isReady: false, hasLocalState: false, error: null });

    const operation = this.load(seedFromContentJson).catch((error: unknown) => {
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

  private async load(seedFromContentJson?: YjsDocumentSeed): Promise<void> {
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
      if (seedFromContentJson && this.ydoc.getXmlFragment('default').length === 0) {
        await seedFromContentJson((mutator) => {
          this.ydoc.transact(() => {
            if (this.ydoc.getXmlFragment('default').length > 0) return;
            mutator(this.ydoc);
          }, 'seed');
        });
        const fullState = Y.encodeStateAsUpdate(this.ydoc);
        const persisted = await this.dependencies.appendAuthoredUpdate(
          this.projectId,
          this.docId,
          fullState,
          { kind: 'system' },
        );
        // A remote transaction can win the database scheduler between the
        // empty-state read and this seed commit. Replay the ordered durable
        // tail before the seed snapshot becomes a future compaction point.
        await this.applyPersistedTail();
        if (this.snapshotCoveredUpdateId < persisted.updateId) {
          throw new Error(
            `Persisted Yjs seed ${persisted.updateId} for ${this.docId} was not visible in SQLite`,
          );
        }
        await this.repo.upsertSnapshot(this.docId, Y.encodeStateAsUpdate(this.ydoc), {
          advanceRevision: false,
        });
      }
    }

    this.status = 'ready';
    if (!this.closing && this.refCount > 0) this.attachUpdateHandler();
    this.publish({
      isReady: true,
      hasLocalState: hadAnything || Boolean(seedFromContentJson),
      error: null,
    });
  }

  private readonly handleUpdate = (update: Uint8Array, origin: unknown): void => {
    if (
      origin === 'load' ||
      origin === 'remote' ||
      origin === 'seed' ||
      origin === 'restore' ||
      origin === PERSISTED_TAIL_ORIGIN
    ) {
      // Remote apply must persist the incoming update and remote change-set in
      // its reducer transaction before applying it to this live document.
      // Seed/restore are likewise owned by their explicit persistence paths.
      return;
    }

    const persistedOrigin = readPersistedYjsUpdateOrigin(origin);
    if (persistedOrigin) {
      // The coordinator committed this exact update and its receipt before
      // merging it into the editor. Do not jump the watermark directly to its
      // id: an earlier remote row for this doc may have committed first but its
      // post-commit delivery can still be queued. Reading the SQLite tail in
      // order proves that every lower stored row is represented before any
      // later snapshot is allowed to compact it.
      this.enqueueWrite(async () => {
        await this.applyPersistedTail();
        this.localUpdatesSinceSnapshot = 0;
      });
      return;
    }

    const revisionSource =
      origin === 'agent' || origin === 'agent-revert'
        ? ({ kind: 'agent' } as const)
        : ({ kind: 'user' } as const);
    const updateCopy = new Uint8Array(update);

    this.enqueueWrite(async () => {
      const persisted = await this.dependencies.appendAuthoredUpdate(
        this.projectId,
        this.docId,
        updateCopy,
        revisionSource,
      );
      // The authored transaction is now durable, but a remote row may have
      // received a lower id while this update was waiting. Replaying the exact
      // ordered tail is what makes `persisted.updateId` safe coverage.
      await this.applyPersistedTail();
      if (this.snapshotCoveredUpdateId < persisted.updateId) {
        throw new Error(
          `Persisted Yjs update ${persisted.updateId} for ${this.docId} was not visible in SQLite`,
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

  private async applyPersistedTail(): Promise<void> {
    const updates = await this.repo.listUpdates(this.docId, this.snapshotCoveredUpdateId);
    for (const item of updates) {
      // listUpdates is ordered by id. Advance only after this exact durable row
      // decodes and merges; a thrown Yjs error therefore leaves the watermark
      // before the bad row and prevents unsafe compaction.
      Y.applyUpdate(this.ydoc, item.updateBlob, PERSISTED_TAIL_ORIGIN);
      this.snapshotCoveredUpdateId = item.id;
    }
  }

  private async persistSnapshotAndCompact(
    fullState: Uint8Array,
    reason: 'periodic' | 'close' = 'periodic',
  ): Promise<void> {
    // Read the session-owned cursor inside the serial queue. It can only name
    // rows that this same Y.Doc successfully replayed or appended before this
    // exact fullState capture was queued.
    const coveredId = this.snapshotCoveredUpdateId;
    // A snapshot only compacts already-durable CRDT state. Advancing the
    // semantic revision here makes a no-op flush look like a competing edit
    // and breaks exact Agent review rollback after the editor is mounted.
    await this.repo.upsertSnapshot(this.docId, fullState, {
      advanceRevision: false,
    });
    this.dependencies.captureSnapshotHistory(this.docId, fullState, reason);
    await this.dependencies.compactUpdatesAfterSnapshot(this.docId, coveredId, this.repo);
  }

  private beginFinalClose(generation: number): void {
    if (this.refCount !== 0 || generation !== this.releaseGeneration || this.closing) return;
    this.closing = true;
    this.detachUpdateHandler();

    if (this.status === 'ready') {
      this.enqueueWrite(async () => {
        await this.applyPersistedTail();
        await this.persistSnapshotAndCompact(Y.encodeStateAsUpdate(this.ydoc), 'close');
      });
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

  get(projectId: string, docId: string, userId: string): YjsDocumentSession {
    if (!projectId) throw new Error('Yjs document session requires projectId');
    const existing = this.sessions.get(docId);
    if (existing) {
      if (existing.userId !== userId) {
        throw new Error(
          `Yjs document ${docId} is still mounted for another user; database switch was not quiesced`,
        );
      }
      if (existing.projectId !== projectId) {
        throw new Error(
          `Yjs document ${docId} is still mounted for another project; document identity is ambiguous`,
        );
      }
      return existing;
    }

    const created = new YjsDocumentSession(projectId, docId, userId, this.dependencies, (session) => {
      if (this.sessions.get(docId) === session) this.sessions.delete(docId);
    });
    this.sessions.set(docId, created);
    return created;
  }

  /** Reconcile only already-open sessions; closed docs will replay SQLite on open. */
  async reconcilePersistedUpdates(
    projectId: string,
    docIds?: readonly string[],
  ): Promise<void> {
    const candidates = docIds
      ? [...new Set(docIds)].sort()
      : [...this.sessions.entries()]
          .filter(([, session]) => session.projectId === projectId)
          .map(([docId]) => docId)
          .sort();
    for (const docId of candidates) {
      const session = this.sessions.get(docId);
      if (!session) continue;
      if (session.projectId !== projectId) {
        throw new Error(
          `Yjs document ${docId} is mounted for another project during remote reconciliation`,
        );
      }
      await session.reconcilePersistedUpdates();
    }
  }
}

const processYjsDocumentSessions = new YjsDocumentSessionRegistry();

export function getYjsDocumentSession(
  projectId: string,
  docId: string,
  userId: string,
): YjsDocumentSession {
  return processYjsDocumentSessions.get(projectId, docId, userId);
}

/**
 * Post-commit SyncEngine bridge. It never opens a new session and therefore
 * cannot race a hidden project into the UI; closed documents simply replay the
 * already-durable update on their next normal mount.
 */
export function reconcileOpenYjsDocumentSessions(
  projectId: string,
  docIds?: readonly string[],
): Promise<void> {
  return processYjsDocumentSessions.reconcilePersistedUpdates(projectId, docIds);
}
