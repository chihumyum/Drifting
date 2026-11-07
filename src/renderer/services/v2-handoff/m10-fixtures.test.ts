// Synthetic 0.1 libraries for the 0.2 importer's acceptance (M10,
// docs/v2-handoff.md). Skipped unless DRIFTING_M10_FIXTURE_DIR names the
// output directory; then it writes, under that directory:
//
//   sample/          both built-in samples exactly as the first run writes them
//   sample-stale/    sample, aged like a library whose app quit inside the
//                    editor debounce: caches behind their Yjs state, history
//                    rows, and no handoff stamp
//   sample-handoff/  sample-stale after WebView preferences and one real
//                    handoff pass at quit
//   truth/<name>.jsonl  the importer's ground truth per library
//   manifest.json
//
// Each library is `<name>/drifting-library.db` (checkpointed and closed, so the
// file is self-contained) plus `<name>/app-local-data/` laid out as the native
// asset store lays it out. Seed libraries already in the directory (`lite/`,
// `stress/`, from the seed CLI) get a truth file and a manifest entry; nothing
// else in the directory is touched.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { extractProseText } from '@drifting/prose-metrics';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../lib/db';
import type { BookIllustration } from '../built-in-sample/book';
import type { ImportedSampleAsset } from '../built-in-sample/built-in-sample';
import type { PersistedYjsDocument } from '../../sqlite-repo/yjs-repo';

const FIXTURE_DIR = process.env.DRIFTING_M10_FIXTURE_DIR;
const SEED_LIBRARIES = ['lite', 'stress'] as const;
const LIBRARY_FILE = 'drifting-library.db';
const STALE_MARK_ZH = '〔退出前打的字〕';
const STALE_MARK_EN = '[typed before quitting] ';
const HOUR_MS = 3_600_000;

/** The renderer modules, loaded only when fixtures are wanted. */
async function load() {
  const { installHeadlessRendererGlobals } = await import('../../../dev-cli/headless-globals');
  // Renderer stores read browser storage when their modules load.
  installHeadlessRendererGlobals();
  return {
    ...(await import('../../../dev-cli/offline-database')),
    ...(await import('../../../dev-cli/offline-workspace')),
    ...(await import('../../../dev-cli/seeds/materials')),
    ...(await import('../built-in-sample/built-in-sample')),
    ...(await import('../built-in-sample/a-q')),
    ...(await import('../built-in-sample/first-run')),
    ...(await import('../sample-project/headless-workspace')),
    ...(await import('../snapshot-history.service')),
    ...(await import('../../store/auth')),
    ...(await import('../../store/data-store')),
    ...(await import('../../store/project-store')),
    ...(await import('../../store/settings-store')),
    ...(await import('../../store/writing-stats-store')),
    ...(await import('../../features/graph/element-relate-layout')),
    ...(await import('../../sync/journal')),
    ...(await import('../../sync/journal/yjs-update')),
    ...(await import('../../lib/agent/runtime/yjs-prose-command')),
    ...(await import('../../sync/reducer/sqlite-materializer')),
    ...(await import('../../sqlite-repo/yjs-repo')),
    ...(await import('./handoff')),
    ...(await import('./runtime')),
  };
}
type Modules = Awaited<ReturnType<typeof load>>;
let loaded: Promise<Modules> | null = null;
const modules = () => (loaded ??= load());

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const libraryPath = (name: string) => join(FIXTURE_DIR!, name, LIBRARY_FILE);

// ── Opening and closing a library ─────────────────────────────────────────

async function openLibrary(name: string) {
  const m = await modules();
  // Migrating an up-to-date library only sets its pragmas, as the app's open does.
  const library = new m.OfflineProductDatabase(libraryPath(name), { migrate: true });
  await library.open();
  return library;
}

type Library = Awaited<ReturnType<typeof openLibrary>>;

/** Drain, checkpoint and close: the `.db` file alone then holds the library. */
async function closeLibrary(library: Library): Promise<void> {
  const m = await modules();
  await m.flushSnapshotHistoryPersistence();
  library.gateway.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  await library.close();
  for (const suffix of ['-wal', '-shm']) {
    const path = `${library.path}${suffix}`;
    if (existsSync(path) && statSync(path).size === 0) rmSync(path);
    expect(existsSync(path), `${path} after close`).toBe(false);
  }
  // Copies share project and sync-generation ids: nothing may carry over.
  m.invalidateSqliteReducerStateCache();
  m.resetBuiltInSampleForTests();
  m.useDataStore.setState(m.useDataStore.getInitialState(), true);
  m.useProjectStore.setState(m.useProjectStore.getInitialState(), true);
  globalThis.localStorage.clear();
}

function freshDirectory(name: string): string {
  const directory = join(FIXTURE_DIR!, name);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(join(directory, 'app-local-data'), { recursive: true });
  return directory;
}

function copyLibrary(from: string, to: string): void {
  rmSync(join(FIXTURE_DIR!, to), { recursive: true, force: true });
  cpSync(join(FIXTURE_DIR!, from), join(FIXTURE_DIR!, to), { recursive: true });
}

// ── Authored edits, as the app writes them ────────────────────────────────

async function authoring(library: Library) {
  const m = await modules();
  const sql = library.gateway.database;
  const one = <T>(query: string, ...parameters: unknown[]) => sql.prepare(query).get(...(parameters as never[])) as T | undefined;
  const write = m.createAuthoredYjsUpdateWriter(m.createAuthoredTransactionRunner({
    database: () => library.client,
    identity: async () => ({
      installationId: 'm10-fixture',
      createWriterIdentity: () => ({ writerId: `writer-${uuidv7()}`, writerEpoch: `epoch-${uuidv7()}` }),
    }),
    clock: () => { const now = new Date(); return { nowMs: now.getTime(), nowIso: now.toISOString() }; },
    syncGenerationIds: {
      createSyncGenerationId: () => `sync-generation-${uuidv7()}`,
      createProjectSyncId: () => `project-sync-${uuidv7()}`,
    },
  }));
  const persisted = async (docId: string) =>
    (await library.client.transaction((tx) => m.readPersistedYjsDocuments(tx, [docId]))).get(docId)!;
  const loadDoc = async (docId: string) => {
    const state = await persisted(docId);
    const doc = new Y.Doc({ gc: false });
    if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
    for (const update of state.updates) Y.applyUpdate(doc, update);
    return doc;
  };
  const firstText = (doc: Y.Doc): Y.XmlText => {
    const visit = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null => {
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlText) return child;
        if (child instanceof Y.XmlElement) {
          const found = visit(child);
          if (found) return found;
        }
      }
      return null;
    };
    const found = visit(doc.getXmlFragment('default'));
    if (!found) throw new Error('The document has no text');
    return found;
  };
  /** An edit persisted the way an open editor persists it, with no cache projection. */
  const typeWithoutProjection = async (projectId: string, docId: string, text: string) => {
    const doc = await loadDoc(docId);
    const before = Y.encodeStateVector(doc);
    firstText(doc).insert(0, text);
    await write(projectId, docId, Y.encodeStateAsUpdate(doc, before), { kind: 'user' });
    doc.destroy();
  };
  /** A history row taken by the app's own capture service, as the editor closes at `at`. */
  const captureHistoryAt = async (docId: string, at: Date) => {
    const doc = await loadDoc(docId);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    // Rows within one hour are thinned to one, so each capture is an hour apart.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      await m.captureSnapshotHistory(docId, state, 'close');
    } finally {
      vi.useRealTimers();
    }
  };
  const idOf = (table: string, projectId: string, column: string, value: string) =>
    one<{ id: string }>(`SELECT id FROM ${table} WHERE project_id = ? AND ${column} = ?`, projectId, value)!.id;
  return { one, write, typeWithoutProjection, captureHistoryAt, idOf };
}

/** The bundled illustration bytes, verified, into the asset store's layout with their receipt. */
function fileAssetImporter(m: Modules, database: DbClient, appLocalData: string) {
  const directory = new URL('../built-in-sample/pride-and-prejudice/', import.meta.url);
  const read = async (file: string, expected: string) => {
    const bytes = new Uint8Array(await readFile(new URL(file, directory)));
    if (sha256(bytes) !== expected) throw new Error(`Sample file ${file} failed its integrity check`);
    return bytes;
  };
  return async (projectId: string, illustration: BookIllustration): Promise<ImportedSampleAsset> => {
    const source = await read(illustration.source, illustration.sha256);
    if (source.byteLength !== illustration.sizeBytes) throw new Error(`Sample file ${illustration.source} has the wrong size`);
    const variants = await Promise.all(Object.entries(illustration.variants).map(async ([variant, metadata]) => ({
      variant,
      bytes: metadata.file === illustration.source ? source : await read(metadata.file, metadata.sha256),
    })));
    const { asset, abandon } = await m.writeSeedAsset(database, appLocalData, projectId, {
      kind: 'image', sourceMime: illustration.mime, sourceExtension: 'jpg', source,
      sha256: illustration.sha256, width: illustration.width, height: illustration.height, variants,
    });
    // The native import marker is cleared on commit; this layout never wrote one.
    return { asset, commit: async () => undefined, abandon };
  };
}

// ── Describing a library: truth lines and manifest entry ──────────────────

const CACHE_QUERY: Record<string, string> = {
  'node-content': 'SELECT n.id, c.content_json AS cache FROM book_node n LEFT JOIN node_content c ON c.node_id = n.id WHERE n.id = ?',
  element: 'SELECT id, content_json AS cache FROM element WHERE id = ?',
  storyline: 'SELECT id, content_json AS cache FROM storylines WHERE id = ?',
  category: 'SELECT id, content_json AS cache FROM element_category WHERE id = ?',
  'library-item': "SELECT id, body_json AS cache FROM library_item WHERE id = ? AND kind = 'text'",
};
const HISTORY_DOC_KIND: Record<string, string> = {
  node: 'node-content', element: 'element', storyline: 'storyline', category: 'category', library_item: 'library-item',
};

interface ManifestEntry {
  name: string;
  path: string;
  appLocalData: string;
  truth: string;
  source: string;
  handoffStamp: boolean;
  stampedAppVersion: string | null;
  projects: { id: string; name: string; trashed: boolean }[];
  documents: {
    withYjsState: number;
    byKind: Record<string, number>;
    /** Stamp entry with the current revision and the cache's SHA-256. */
    stamped: number;
    notStamped: number;
    /** Cache bytes differ from the Yjs rendering. */
    staleCaches: number;
    staleByKind: Record<string, number>;
    /** Cache text differs from the Yjs rendering's text (extractProseText). */
    textStaleCaches: number;
    textStaleDocuments: string[];
    orphaned: number;
  };
  history: { rows: number; documents: number; previewMissing: number };
  commentsWithTextAnchor: number;
  patchesWithTextAnchor: number;
  assets: { rows: number; withSourceBytes: number };
  books: Record<string, unknown> | null;
  notes?: Record<string, unknown>;
}

/**
 * Read a closed library without leaving `-wal`/`-shm` files beside it (a
 * read-only WAL connection cannot remove them). Immutable skips the WAL, so
 * only a checkpointed file qualifies.
 */
function openClosedLibrary(name: string): DatabaseSync {
  const path = libraryPath(name);
  if (existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) throw new Error(`${path} has a WAL that was not checkpointed`);
  const url = pathToFileURL(path);
  url.searchParams.set('mode', 'ro');
  url.searchParams.set('immutable', '1');
  return new DatabaseSync(url, { readOnly: true });
}

async function describeLibrary(name: string, source: string, notes?: Record<string, unknown>): Promise<ManifestEntry> {
  const m = await modules();
  const database = openClosedLibrary(name);
  const lines: string[] = [];
  try {
    const all = <T>(query: string, ...parameters: unknown[]) => database.prepare(query).all(...(parameters as never[])) as T[];
    const one = <T>(query: string, ...parameters: unknown[]) => database.prepare(query).get(...(parameters as never[])) as T | undefined;
    const stampRow = one<{ json: string }>("SELECT value_json AS json FROM library_state WHERE key = 'v2-handoff'");
    const stamp = stampRow ? JSON.parse(stampRow.json) as {
      appVersion: string | null; documents: Record<string, { revision: number; sha256: string }>; books?: Record<string, unknown>;
    } : null;
    const documents: ManifestEntry['documents'] = {
      withYjsState: 0, byKind: {}, stamped: 0, notStamped: 0, staleCaches: 0, staleByKind: {},
      textStaleCaches: 0, textStaleDocuments: [], orphaned: 0,
    };
    const textOf = (json: string | null) => (json ? extractProseText(JSON.parse(json) as Parameters<typeof extractProseText>[0]) : '');
    const docIds = all<{ id: string }>('SELECT document_id AS id FROM yjs_updates UNION SELECT document_id FROM yjs_snapshots ORDER BY 1')
      .map((row) => row.id);
    for (const documentId of docIds) {
      const state: PersistedYjsDocument = {
        snapshot: one<{ blob: Uint8Array }>('SELECT state_blob AS blob FROM yjs_snapshots WHERE document_id = ?', documentId)?.blob ?? null,
        updates: all<{ blob: Uint8Array }>('SELECT update_blob AS blob FROM yjs_updates WHERE document_id = ? ORDER BY id', documentId)
          .map((row) => row.blob),
        revision: one<{ revision: number }>('SELECT revision FROM yjs_document_revision WHERE document_id = ?', documentId)?.revision ?? 0,
      };
      const prose = m.renderPersistedProse(state);
      lines.push(JSON.stringify({ documentId, revision: state.revision, prose: JSON.parse(prose) }));
      const kind = documentId.slice(0, documentId.indexOf(':'));
      documents.withYjsState += 1;
      documents.byKind[kind] = (documents.byKind[kind] ?? 0) + 1;
      const owner = CACHE_QUERY[kind]
        ? one<{ cache: string | null }>(CACHE_QUERY[kind], documentId.slice(kind.length + 1))
        : undefined;
      const entry = stamp?.documents[documentId];
      if (!owner) {
        documents.orphaned += 1;
      } else if (owner.cache !== prose) {
        documents.staleCaches += 1;
        documents.staleByKind[kind] = (documents.staleByKind[kind] ?? 0) + 1;
        if (textOf(owner.cache) !== textOf(prose)) {
          documents.textStaleCaches += 1;
          documents.textStaleDocuments.push(documentId);
        }
      }
      if (owner?.cache != null && entry && entry.revision === state.revision && entry.sha256 === sha256(owner.cache)) documents.stamped += 1;
      else documents.notStamped += 1;
    }
    const history = all<{ id: string; kind: string; entityId: string; blob: Uint8Array; preview: string | null }>(
      'SELECT id, entity_kind AS kind, entity_id AS entityId, state_blob AS blob, content_json AS preview FROM entity_snapshot_history ORDER BY id',
    );
    for (const row of history) {
      const prose = m.renderPersistedProse({ snapshot: row.blob, updates: [], revision: 0 });
      lines.push(JSON.stringify({ historyId: row.id, documentId: `${HISTORY_DOC_KIND[row.kind]}:${row.entityId}`, prose: JSON.parse(prose) }));
    }
    const assets = all<{ id: string; projectId: string; sha: string }>(
      'SELECT id, project_id AS projectId, source_sha256 AS sha FROM project_asset ORDER BY id',
    );
    const withSourceBytes = assets.filter(({ id, projectId, sha }) => {
      const directory = join(FIXTURE_DIR!, name, 'app-local-data', 'assets', projectId, id);
      if (!existsSync(directory)) return false;
      const file = readdirSync(directory).find((entry) => entry.startsWith('source.'));
      return file !== undefined && sha256(readFileSync(join(directory, file))) === sha;
    }).length;
    mkdirSync(join(FIXTURE_DIR!, 'truth'), { recursive: true });
    writeFileSync(join(FIXTURE_DIR!, 'truth', `${name}.jsonl`), `${lines.join('\n')}\n`);
    return {
      name,
      path: `${name}/${LIBRARY_FILE}`,
      appLocalData: `${name}/app-local-data`,
      truth: `truth/${name}.jsonl`,
      source,
      handoffStamp: stamp !== null,
      stampedAppVersion: stamp?.appVersion ?? null,
      projects: all<{ id: string; name: string; deletedAt: string | null }>(
        'SELECT id, name, deleted_at AS deletedAt FROM project ORDER BY created_at, id',
      ).map((project) => ({ id: project.id, name: project.name, trashed: project.deletedAt !== null })),
      documents,
      history: {
        rows: history.length,
        documents: new Set(history.map((row) => `${row.kind}:${row.entityId}`)).size,
        previewMissing: history.filter((row) => row.preview === null).length,
      },
      commentsWithTextAnchor: one<{ n: number }>(
        "SELECT count(*) AS n FROM comment WHERE json_valid(anchor_json) AND json_type(anchor_json, '$.textAnchor') = 'object'",
      )!.n,
      patchesWithTextAnchor: one<{ n: number }>('SELECT count(*) AS n FROM element_patch WHERE text_anchor_json IS NOT NULL')!.n,
      assets: { rows: assets.length, withSourceBytes },
      books: stamp?.books ?? null,
      ...(notes ? { notes } : {}),
    };
  } finally {
    database.close();
  }
}

/** The seed CLI writes its summary as the last line of `<name>.log` when it is done. */
function seedLibraryReady(name: string): boolean {
  if (!existsSync(libraryPath(name))) return false;
  const log = [join(FIXTURE_DIR!, `${name}.log`), join(FIXTURE_DIR!, name, `${name}.log`)].find((path) => existsSync(path));
  if (!log) return true;
  const lines = readFileSync(log, 'utf8').trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  try {
    JSON.parse(last);
    return true;
  } catch {
    throw new Error(`${name} is still being generated (${log} does not end with its JSON summary)`);
  }
}

// ── The fixtures ──────────────────────────────────────────────────────────

const manifest: ManifestEntry[] = [];

describe.skipIf(!FIXTURE_DIR)('M10 import fixtures', () => {
  it('sample: both built-in samples as the first run writes them', async () => {
    const m = await modules();
    const directory = freshDirectory('sample');
    const library = await openLibrary('sample');
    try {
      const outcome = await m.ensureBuiltInSampleProject({
        database: () => library.client,
        userId: m.LOCAL_USER_ID,
        runAtomic: m.createAtomicRunner(library.client),
        importAsset: fileAssetImporter(m, library.client, join(directory, 'app-local-data')),
        discardProject: async (projectId) => { await m.purgeUnpublishedSampleProject(library.client, projectId); },
        now: () => new Date().toISOString(),
        newId: uuidv7,
        samples: m.BUILT_IN_SAMPLES,
      });
      expect(outcome.kind).toBe('created');
    } finally {
      await closeLibrary(library);
    }
    const entry = await describeLibrary('sample', 'ensureBuiltInSampleProject(BUILT_IN_SAMPLES), the first run');
    expect(entry.projects.map((project) => project.name)).toEqual(m.BUILT_IN_SAMPLES.map((sample) => sample.name));
    // The first run's chapter caches carry entity-link marks in their own
    // attribute order, without the schema's null defaults: not the Yjs bytes,
    // but the same text. Opening a chapter repairs its cache; the handoff
    // repairs them all.
    expect(entry.documents.textStaleCaches).toBe(0);
    expect(entry.assets.withSourceBytes).toBe(entry.assets.rows);
    manifest.push(entry);
  }, 600_000);

  it('sample-stale: caches behind Yjs, history rows, no handoff stamp', async () => {
    const m = await modules();
    copyLibrary('sample', 'sample-stale');
    const library = await openLibrary('sample-stale');
    const stale: { documentId: string; kind: string; project: string }[] = [];
    const historyDocuments: string[] = [];
    try {
      const a = await authoring(library);
      const projectId = (name: string) => a.one<{ id: string }>('SELECT id FROM project WHERE name = ?', name)!.id;
      const ppName = m.BUILT_IN_SAMPLES[0]!.name;
      const aq = projectId(m.A_Q_PROJECT_NAME);
      const pp = projectId(ppName);

      const chapter = `node-content:${a.idOf('book_node', aq, 'title', '第四章 恋爱的悲剧')}`;
      const element = `element:${a.idOf('element', aq, 'name', '赵太爷')}`;
      const storyline = `storyline:${a.idOf('storylines', aq, 'name', '未庄的眼睛')}`;
      const category = `category:${a.idOf('element_category', aq, 'name', '人物')}`;
      const noteRow = a.one<{ id: string; body: string }>(
        "SELECT id, body_json AS body FROM library_item WHERE project_id = ? AND kind = 'text' AND title = ?", aq, '《阿Q正传》的发表',
      )!;
      const note = `library-item:${noteRow.id}`;
      const ppChapter = `node-content:${a.one<{ id: string }>("SELECT id FROM book_node WHERE project_id = ? AND kind = 'chapter' ORDER BY id LIMIT 1", pp)!.id}`;
      const ppElement = `element:${a.one<{ id: string }>('SELECT id FROM element WHERE project_id = ? ORDER BY id LIMIT 1', pp)!.id}`;

      // A note gets its document from bodyJson the first time it is opened.
      await a.write(aq, note, await m.createYjsProseSeedState(noteRow.body, 'note'), { kind: 'user' });

      // History: the editor closed three times, an hour apart, on two documents.
      await m.hydrateHeadlessWorkspace(library.client, aq, m.createAtomicRunner(library.client));
      const now = Date.now();
      for (const docId of [chapter, element]) {
        await a.captureHistoryAt(docId, new Date(now - 3 * HOUR_MS));
        await a.typeWithoutProjection(aq, docId, '〔第一稿〕');
        await a.captureHistoryAt(docId, new Date(now - 2 * HOUR_MS));
        await a.typeWithoutProjection(aq, docId, '〔第二稿〕');
        await a.captureHistoryAt(docId, new Date(now - HOUR_MS));
        historyDocuments.push(docId);
      }
      expect(a.one<{ n: number }>('SELECT count(*) AS n FROM entity_snapshot_history')!.n).toBe(6);

      // The quit inside the persist debounce: the last edit reached Yjs, not its cache.
      for (const [docId, project, kind] of [
        [chapter, aq, 'chapter'], [element, aq, 'element'], [storyline, aq, 'storyline'],
        [category, aq, 'category'], [note, aq, 'material note'], [ppChapter, pp, 'chapter'], [ppElement, pp, 'element'],
      ] as const) {
        await a.typeWithoutProjection(project, docId, project === aq ? STALE_MARK_ZH : STALE_MARK_EN);
        stale.push({ documentId: docId, kind, project: project === aq ? m.A_Q_PROJECT_NAME : ppName });
      }

      // Anchored review work: the samples write it; add it only if a recipe ever drops it.
      const anchoredComments = a.one<{ n: number }>(
        "SELECT count(*) AS n FROM comment WHERE json_valid(anchor_json) AND json_type(anchor_json, '$.textAnchor') = 'object'",
      )!.n;
      const anchoredPatches = a.one<{ n: number }>('SELECT count(*) AS n FROM element_patch WHERE text_anchor_json IS NOT NULL')!.n;
      expect(anchoredComments, 'comments with a v4 textAnchor').toBeGreaterThan(0);
      expect(anchoredPatches, 'element patches with text_anchor_json').toBeGreaterThan(0);
      expect(a.one('SELECT 1 FROM library_state WHERE key = ?', 'v2-handoff')).toBeUndefined();
    } finally {
      await closeLibrary(library);
    }
    const entry = await describeLibrary('sample-stale', 'sample + Yjs edits without their cache projection + snapshot history', {
      staleDocuments: stale,
      historyDocuments,
    });
    expect(entry.documents.textStaleDocuments.sort()).toEqual(stale.map((doc) => doc.documentId).sort());
    expect(entry.history.rows).toBe(6);
    expect(entry.handoffStamp).toBe(false);
    manifest.push(entry);
  }, 600_000);

  it('sample-handoff: preferences in WebView storage and one real handoff pass at quit', async () => {
    const m = await modules();
    copyLibrary('sample-stale', 'sample-handoff');
    const library = await openLibrary('sample-handoff');
    let result: Awaited<ReturnType<Modules['runV2Handoff']>>;
    const otherLibraryBook = uuidv7();
    try {
      const a = await authoring(library);
      const aq = a.one<{ id: string }>('SELECT id FROM project WHERE name = ?', m.A_Q_PROJECT_NAME)!.id;
      const relationTypes = library.gateway.database
        .prepare('SELECT id FROM entity_relation_type WHERE project_id = ? ORDER BY id LIMIT 2').all(aq) as { id: string }[];
      const elements = library.gateway.database
        .prepare('SELECT id FROM element WHERE project_id = ? ORDER BY id LIMIT 3').all(aq) as { id: string }[];
      expect(relationTypes).toHaveLength(2);
      expect(elements).toHaveLength(3);

      // Written by the stores' own persistence, so every payload is in its real format.
      m.useSettingsStore.getState().setThemeMode('dark');
      m.useSettingsStore.getState().setBodyFontSize(19);
      const stats = m.useWritingStatsStore.getState();
      stats.setProjectWordTarget(aq, 80000);
      stats.setDailyWordGoal(aq, 0);
      stats.recordTotalWords(aq, 31234);
      // WebView storage is app-wide: a book of another library is in it too.
      stats.setProjectWordTarget(otherLibraryBook, 5000);
      // useEdgeKindMeta's payload (its writer is private to the hook).
      localStorage.setItem(`drifting:edge-kind-meta:${aq}`, JSON.stringify({
        v: 2, byRelationTypeId: { [relationTypes[0]!.id]: { color: '#aabbcc' }, [relationTypes[1]!.id]: { color: '#3a7d44' } },
      }));
      localStorage.setItem(`drifting:edge-kind-meta:${otherLibraryBook}`, JSON.stringify({ v: 2, byRelationTypeId: { x: { color: '#000000' } } }));
      m.writeRelateRecord(aq, {
        mode: 'relate',
        positions: new Map(elements.map((element, index) => [element.id, { x: index * 40, y: index * -25 }])),
        pins: new Map([[elements[0]!.id, { x: 12.5, y: -40 }], [elements[1]!.id, { x: -180, y: 96.3 }]]),
        signature: null,
      });
      expect(localStorage.getItem('settings-storage')).toContain('"themeMode":"dark"');

      result = await m.runV2Handoff({ liveDocuments: 'include' }, {
        ...m.defaultV2HandoffDependencies(),
        database: () => library.client,
        appVersion: async () => (JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version,
        isLive: () => false,
        yieldToUi: async () => undefined,
      });
      expect(result).toMatchObject({ failed: 0, orphaned: 0, deferred: 0, skippedLive: 0 });
      const stamp = (await m.readV2HandoffState(library.client))!;
      expect(stamp.books).toEqual({
        [aq]: {
          wordTarget: 80000,
          dailyWordTarget: 0,
          relationTypeColors: { [relationTypes[0]!.id]: '#aabbcc', [relationTypes[1]!.id]: '#3a7d44' },
          elementPins: { [elements[0]!.id]: [12.5, -40], [elements[1]!.id]: [-180, 96.3] },
        },
      });
      expect(Object.keys(stamp.settings!.entries)).toContain('settings-storage');
    } finally {
      await closeLibrary(library);
    }
    const entry = await describeLibrary('sample-handoff', 'sample-stale + WebView preferences + runV2Handoff({ liveDocuments: "include" })', {
      handoff: result,
      otherLibraryBookInStorage: otherLibraryBook,
    });
    expect(entry.documents).toMatchObject({ staleCaches: 0, notStamped: 0 });
    expect(entry.documents.stamped).toBe(entry.documents.withYjsState);
    manifest.push(entry);
  }, 600_000);

  it('truth for the seed libraries already in the directory', async () => {
    for (const name of SEED_LIBRARIES) {
      if (!seedLibraryReady(name)) continue;
      manifest.push(await describeLibrary(name, `pnpm dev:seed (${name} preset), not written by this file`));
    }
  }, 600_000);

  it('manifest', () => {
    writeFileSync(join(FIXTURE_DIR!, 'manifest.json'), `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      generator: 'src/renderer/services/v2-handoff/m10-fixtures.test.ts',
      truthFormat: {
        document: '{"documentId","revision","prose"}: prose is JSON.parse(renderPersistedProse(current Yjs state))',
        history: '{"historyId","documentId","prose"}: prose rendered from entity_snapshot_history.state_blob',
      },
      libraries: manifest,
    }, null, 2)}\n`);
  });
});
