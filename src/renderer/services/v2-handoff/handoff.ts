// The handoff to Drifting 0.2 (docs/v2-handoff.md). The rewrite reads this
// library's SQLite directly and has no Yjs; the one thing it cannot check on
// its own is whether a body's contentJson cache shows the current Yjs state.
// This pass makes every cache equal to its Yjs rendering and records, in
// library_state, the revision and SHA-256 at which it did, plus the
// author's preferences that only exist in WebView storage: raw, and read
// per book for this library's books.
//
// The stamp is a claim the importer re-checks (same revision, same hash), so
// an entry that went stale can only make the importer ask, never import a
// wrong body. Caches are written through derived, never-journaled
// transactions; nothing here syncs or changes what the author sees.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

import type { DbClient, DbExecutor } from '../../lib/db';
import { parseDocId, type DocKind } from '../../lib/yjs-doc-id';
import {
  BookElementTable,
  BookNodeTable,
  ElementCategoryTable,
  EntitySnapshotHistoryTable,
  LibraryItemTable,
  NodeContentTable,
  ProjectTable,
  StorylineTable,
  YjsDocumentRevisionTable,
  yjsSnapshots,
  yjsUpdates,
} from '../../schema/drizzle';
import { createLibraryStateRepository } from '../../sqlite-repo/library-state-repo';
import {
  readPersistedYjsDocuments,
  YJS_DOCUMENT_READ_BATCH_SIZE,
  type PersistedYjsDocument,
} from '../../sqlite-repo/yjs-repo';
import { runDerivedTransaction } from '../../sync/journal';
import { normalizeV2HandoffBooks, type V2HandoffBook } from './books';

export type { V2HandoffBook } from './books';

export const V2_HANDOFF_STATE_KEY = 'v2-handoff';
export const V2_HANDOFF_FORMAT_VERSION = 1;
/** History rows whose preview failed to render, retried per pass. */
const HISTORY_PREVIEW_BATCH = 32;

export interface V2HandoffDocument {
  /** `yjs_document_revision.revision` the cache was verified at. */
  revision: number;
  /** Lower-case hex SHA-256 of the cache's UTF-8 bytes. */
  sha256: string;
}

export interface V2HandoffSettings {
  capturedAt: string;
  /** Raw WebView storage values, by key. */
  entries: Record<string, string>;
}

export interface V2HandoffState {
  version: typeof V2_HANDOFF_FORMAT_VERSION;
  appVersion: string | null;
  updatedAt: string;
  documents: Record<string, V2HandoffDocument>;
  settings: V2HandoffSettings | null;
  /**
   * Per-book preferences read from WebView storage, by project id, for the
   * books in this library. Absent in stamps written before it existed; a book
   * with nothing to say is left out.
   */
  books?: Record<string, V2HandoffBook>;
}

export interface V2HandoffResult {
  /** Documents whose revision differed from their entry. */
  candidates: number;
  processed: number;
  /** Caches rewritten from Yjs. */
  refreshed: number;
  stamped: number;
  /** Open in an editor during a background pass; checked on the next one. */
  skippedLive: number;
  /** Yjs rows whose owner row is gone (a deleted material keeps its rows). */
  orphaned: number;
  failed: number;
  /** Left for the next pass when the budget ran out. */
  deferred: number;
  previewsFilled: number;
}

type OwnerKind = Exclude<DocKind, 'node-content'>;

export interface V2HandoffDependencies {
  database(): DbClient;
  now(): string;
  /** Milliseconds, for the budget. */
  clock(): number;
  appVersion(): Promise<string | null>;
  captureSettings(): Record<string, string> | null;
  /** The `books` section for these projects, or null when storage is unavailable. */
  captureBooks(projectIds: readonly string[]): Record<string, V2HandoffBook> | null;
  /** A chapter or idea cache travels with its outline, word count and basis. */
  refreshNode(projectId: string, nodeId: string): Promise<void>;
  /** Mirror a refreshed element, storyline, category or note cache into the open workspace. */
  publish(kind: OwnerKind, entityId: string, json: string): void;
  isLive(docId: string): boolean;
  yieldToUi(): Promise<void>;
}

export interface V2HandoffOptions {
  /**
   * `skip` while the author may be typing: an open editor owns its cache.
   * `include` at quit, after editors were saved and Yjs queues drained.
   */
  liveDocuments: 'skip' | 'include';
  /** Stop between batches after this long. */
  budgetMs?: number;
  shouldStop?: () => boolean;
}

interface Owner {
  kind: DocKind;
  entityId: string;
  projectId: string;
  cache: string | null;
}

function emptyState(): V2HandoffState {
  return { version: V2_HANDOFF_FORMAT_VERSION, appVersion: null, updatedAt: '', documents: {}, settings: null };
}

function readState(value: unknown): V2HandoffState {
  if (!value || typeof value !== 'object') return emptyState();
  const raw = value as Partial<V2HandoffState>;
  if (raw.version !== V2_HANDOFF_FORMAT_VERSION) return emptyState();
  const documents: Record<string, V2HandoffDocument> = {};
  for (const [docId, entry] of Object.entries(raw.documents ?? {})) {
    if (entry && Number.isSafeInteger(entry.revision) && typeof entry.sha256 === 'string') {
      documents[docId] = { revision: entry.revision, sha256: entry.sha256 };
    }
  }
  const { books, ...rest } = raw;
  return {
    ...emptyState(),
    ...rest,
    documents,
    settings: raw.settings ?? null,
    ...(books && typeof books === 'object' ? { books: normalizeV2HandoffBooks(books, Object.keys(books)) } : {}),
  };
}

export async function readV2HandoffState(database: DbExecutor): Promise<V2HandoffState | null> {
  const value = await createLibraryStateRepository(database).read<unknown>(V2_HANDOFF_STATE_KEY);
  return value === null ? null : readState(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The same rendering the node projection and the sync kernel write. */
export function renderPersistedProse(state: PersistedYjsDocument): string {
  const doc = new Y.Doc({ gc: false });
  try {
    if (state.snapshot) Y.applyUpdate(doc, state.snapshot, 'v2-handoff');
    for (const update of state.updates) Y.applyUpdate(doc, update, 'v2-handoff');
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } finally {
    doc.destroy();
  }
}

/** Every document with Yjs state, and its revision. */
async function listRevisions(database: DbExecutor): Promise<Map<string, number>> {
  const revisions = new Map<string, number>();
  for (const row of await database.selectDistinct({ docId: yjsUpdates.docId }).from(yjsUpdates)) revisions.set(row.docId, 0);
  for (const row of await database.select({ docId: yjsSnapshots.docId }).from(yjsSnapshots)) revisions.set(row.docId, 0);
  for (const row of await database.select().from(YjsDocumentRevisionTable)) {
    if (revisions.has(row.docId)) revisions.set(row.docId, row.revision);
  }
  return revisions;
}

async function readOwners(tx: DbExecutor, docIds: readonly string[]): Promise<Map<string, Owner>> {
  const byKind = new Map<DocKind, string[]>();
  for (const docId of docIds) {
    const parsed = parseDocId(docId);
    if (!parsed) continue;
    byKind.set(parsed.kind, [...(byKind.get(parsed.kind) ?? []), parsed.entityId]);
  }
  const owners = new Map<string, Owner>();
  const add = (kind: DocKind, rows: { id: string; projectId: string; cache: string | null }[]) => {
    for (const row of rows) owners.set(`${kind}:${row.id}`, { kind, entityId: row.id, projectId: row.projectId, cache: row.cache });
  };
  for (const [kind, ids] of byKind) {
    switch (kind) {
      case 'node-content':
        add(kind, await tx
          .select({ id: BookNodeTable.id, projectId: BookNodeTable.projectId, cache: NodeContentTable.contentJson })
          .from(BookNodeTable)
          .leftJoin(NodeContentTable, eq(NodeContentTable.nodeId, BookNodeTable.id))
          .where(inArray(BookNodeTable.id, ids)));
        break;
      case 'element':
        add(kind, await tx
          .select({ id: BookElementTable.id, projectId: BookElementTable.projectId, cache: BookElementTable.contentJson })
          .from(BookElementTable)
          .where(inArray(BookElementTable.id, ids)));
        break;
      case 'storyline':
        add(kind, await tx
          .select({ id: StorylineTable.id, projectId: StorylineTable.projectId, cache: StorylineTable.contentJson })
          .from(StorylineTable)
          .where(inArray(StorylineTable.id, ids)));
        break;
      case 'category':
        add(kind, await tx
          .select({ id: ElementCategoryTable.id, projectId: ElementCategoryTable.projectId, cache: ElementCategoryTable.contentJson })
          .from(ElementCategoryTable)
          .where(inArray(ElementCategoryTable.id, ids)));
        break;
      case 'library-item':
        add(kind, await tx
          .select({ id: LibraryItemTable.id, projectId: LibraryItemTable.projectId, cache: LibraryItemTable.bodyJson })
          .from(LibraryItemTable)
          .where(and(inArray(LibraryItemTable.id, ids), eq(LibraryItemTable.kind, 'text'))));
        break;
    }
  }
  return owners;
}

/** Only the cache column: the owner's updated_at stays the author's. */
async function writeCache(owner: Owner & { kind: OwnerKind }, json: string): Promise<void> {
  await runDerivedTransaction('prose.v2-handoff-projection', async (tx) => {
    switch (owner.kind) {
      case 'element':
        await tx.update(BookElementTable).set({ contentJson: json })
          .where(and(eq(BookElementTable.id, owner.entityId), eq(BookElementTable.projectId, owner.projectId)));
        return;
      case 'storyline':
        await tx.update(StorylineTable).set({ contentJson: json })
          .where(and(eq(StorylineTable.id, owner.entityId), eq(StorylineTable.projectId, owner.projectId)));
        return;
      case 'category':
        await tx.update(ElementCategoryTable).set({ contentJson: json })
          .where(and(eq(ElementCategoryTable.id, owner.entityId), eq(ElementCategoryTable.projectId, owner.projectId)));
        return;
      case 'library-item':
        await tx.update(LibraryItemTable).set({ bodyJson: json })
          .where(and(eq(LibraryItemTable.id, owner.entityId), eq(LibraryItemTable.projectId, owner.projectId), eq(LibraryItemTable.kind, 'text')));
        return;
    }
  });
}

/** SQLite blobs arrive as bytes, buffers or number arrays depending on the driver. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  const buffer = value as { type?: string; data?: number[] } | null;
  if (buffer?.type === 'Buffer' && Array.isArray(buffer.data)) return Uint8Array.from(buffer.data);
  throw new Error('Unsupported blob format');
}

/** A history row whose preview failed to render when it was captured gets one now. */
async function fillHistoryPreviews(): Promise<number> {
  return runDerivedTransaction('prose.v2-handoff-history-preview', async (tx) => {
    const rows = await tx
      .select({ id: EntitySnapshotHistoryTable.id, stateBlob: EntitySnapshotHistoryTable.stateBlob })
      .from(EntitySnapshotHistoryTable)
      .where(isNull(EntitySnapshotHistoryTable.contentJson))
      .limit(HISTORY_PREVIEW_BATCH);
    let filled = 0;
    for (const row of rows) {
      let json: string;
      try {
        json = renderPersistedProse({ snapshot: toBytes(row.stateBlob), updates: [], revision: 0 });
      } catch {
        continue;
      }
      await tx.update(EntitySnapshotHistoryTable).set({ contentJson: json }).where(eq(EntitySnapshotHistoryTable.id, row.id));
      filled += 1;
    }
    return filled;
  });
}

/**
 * Bring the stamp up to date: every document whose revision moved since its
 * entry is rendered, its cache rewritten if it differs, and re-read at one
 * boundary before it is stamped.
 */
export async function runV2Handoff(
  options: V2HandoffOptions,
  dependencies: V2HandoffDependencies,
): Promise<V2HandoffResult> {
  const result: V2HandoffResult = {
    candidates: 0, processed: 0, refreshed: 0, stamped: 0, skippedLive: 0,
    orphaned: 0, failed: 0, deferred: 0, previewsFilled: 0,
  };
  const started = dependencies.clock();
  const database = dependencies.database();
  const previous = (await readV2HandoffState(database)) ?? emptyState();
  const documents = { ...previous.documents };
  const revisions = await listRevisions(database);
  for (const docId of Object.keys(documents)) if (!revisions.has(docId)) delete documents[docId];
  const candidates = [...revisions]
    .filter(([docId, revision]) => documents[docId]?.revision !== revision)
    .map(([docId]) => docId)
    .sort();
  result.candidates = candidates.length;

  for (let offset = 0; offset < candidates.length; offset += YJS_DOCUMENT_READ_BATCH_SIZE) {
    if (offset > 0) {
      const outOfTime = options.budgetMs !== undefined && dependencies.clock() - started >= options.budgetMs;
      if (outOfTime || options.shouldStop?.()) {
        result.deferred = candidates.length - offset;
        break;
      }
      await dependencies.yieldToUi();
    }
    const batch = candidates.slice(offset, offset + YJS_DOCUMENT_READ_BATCH_SIZE);
    const read = await database.transaction(async (tx) => ({
      states: await readPersistedYjsDocuments(tx, batch),
      owners: await readOwners(tx, batch),
    }));
    const rendered = new Map<string, { revision: number; json: string }>();
    for (const docId of batch) {
      result.processed += 1;
      const owner = read.owners.get(docId);
      if (!owner) {
        result.orphaned += 1;
        delete documents[docId];
        continue;
      }
      if (options.liveDocuments === 'skip' && dependencies.isLive(docId)) {
        result.skippedLive += 1;
        continue;
      }
      const state = read.states.get(docId)!;
      try {
        const json = renderPersistedProse(state);
        rendered.set(docId, { revision: state.revision, json });
        if (owner.cache === json) continue;
        if (owner.kind === 'node-content') {
          await dependencies.refreshNode(owner.projectId, owner.entityId);
        } else {
          const kind = owner.kind;
          await writeCache({ ...owner, kind }, json);
          dependencies.publish(kind, owner.entityId, json);
        }
        result.refreshed += 1;
      } catch {
        result.failed += 1;
        rendered.delete(docId);
        delete documents[docId];
      }
    }
    // Stamp only what is still true at one boundary: same revision, and the
    // cache is exactly the rendering of that revision.
    const ids = [...rendered.keys()];
    if (!ids.length) continue;
    const check = await database.transaction(async (tx) => ({
      revisions: new Map((await tx.select().from(YjsDocumentRevisionTable).where(inArray(YjsDocumentRevisionTable.docId, ids)))
        .map((row) => [row.docId, row.revision])),
      owners: await readOwners(tx, ids),
    }));
    for (const [docId, { revision, json }] of rendered) {
      if ((check.revisions.get(docId) ?? 0) === revision && check.owners.get(docId)?.cache === json) {
        documents[docId] = { revision, sha256: await sha256Hex(json) };
        result.stamped += 1;
      } else {
        delete documents[docId];
      }
    }
  }

  result.previewsFilled = await fillHistoryPreviews();
  const now = dependencies.now();
  const captured = dependencies.captureSettings();
  // WebView storage is app-wide; only this library's books go in its stamp.
  const projectIds = (await database.select({ id: ProjectTable.id }).from(ProjectTable)).map((row) => row.id);
  const books = dependencies.captureBooks(projectIds)
    ?? (previous.books ? normalizeV2HandoffBooks(previous.books, projectIds) : undefined);
  const state: V2HandoffState = {
    version: V2_HANDOFF_FORMAT_VERSION,
    appVersion: await dependencies.appVersion(),
    updatedAt: now,
    documents,
    settings: captured ? { capturedAt: now, entries: captured } : previous.settings,
    ...(books ? { books } : {}),
  };
  await runDerivedTransaction('library.v2-handoff-stamp', (tx) =>
    createLibraryStateRepository(tx).write(V2_HANDOFF_STATE_KEY, state, now));
  return result;
}
