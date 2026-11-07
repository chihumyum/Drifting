import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import { installHeadlessRendererGlobals } from '../../../dev-cli/headless-globals';

// Renderer stores read browser storage when their modules load.
installHeadlessRendererGlobals();
const { OfflineProductDatabase } = await import('../../../dev-cli/offline-database');
const { createAtomicRunner } = await import('../../../dev-cli/offline-workspace');
const { BUILT_IN_SAMPLES, ensureBuiltInSampleProject, purgeUnpublishedSampleProject } = await import('../built-in-sample/built-in-sample');
const { A_Q_PROJECT_NAME } = await import('../built-in-sample/a-q');
const { resetBuiltInSampleForTests } = await import('../built-in-sample/first-run');
const { LOCAL_USER_ID } = await import('../../store/auth');
const { createAuthoredTransactionRunner } = await import('../../sync/journal');
const { createAuthoredYjsUpdateWriter } = await import('../../sync/journal/yjs-update');
const { createYjsProseSeedState } = await import('../../lib/agent/runtime/yjs-prose-command');
const { invalidateSqliteReducerStateCache } = await import('../../sync/reducer/sqlite-materializer');
const { readPersistedYjsDocuments } = await import('../../sqlite-repo/yjs-repo');
const { readV2HandoffState, renderPersistedProse, runV2Handoff, sha256Hex } = await import('./handoff');
const { defaultV2HandoffDependencies } = await import('./runtime');
const { captureV2HandoffSettings } = await import('./settings');

type Library = InstanceType<typeof OfflineProductDatabase>;
type Dependencies = ReturnType<typeof defaultV2HandoffDependencies>;

const directories: string[] = [];
const libraries: Library[] = [];

afterEach(async () => {
  for (const library of libraries.splice(0)) await library.close();
  invalidateSqliteReducerStateCache();
  resetBuiltInSampleForTests();
  globalThis.localStorage?.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A library holding 阿Q正传 exactly as the app's first run writes it. */
async function sampleLibrary() {
  const directory = mkdtempSync(join(tmpdir(), 'drifting-v2-handoff-'));
  directories.push(directory);
  const library = new OfflineProductDatabase(join(directory, 'drifting-library.db'), { migrate: true });
  await library.open();
  libraries.push(library);
  const outcome = await ensureBuiltInSampleProject({
    database: () => library.client,
    userId: LOCAL_USER_ID,
    runAtomic: createAtomicRunner(library.client),
    importAsset: async () => { throw new Error('阿Q正传 has no illustrations'); },
    discardProject: async (projectId) => { await purgeUnpublishedSampleProject(library.client, projectId); },
    now: () => new Date().toISOString(),
    newId: uuidv7,
    samples: BUILT_IN_SAMPLES.filter((sample) => sample.name === A_Q_PROJECT_NAME),
  });
  expect(outcome.kind).toBe('created');
  const sql = library.gateway.database;
  const one = <T = Record<string, unknown>>(query: string, ...parameters: unknown[]) =>
    sql.prepare(query).get(...(parameters as never[])) as T | undefined;
  const all = <T = Record<string, unknown>>(query: string, ...parameters: unknown[]) =>
    sql.prepare(query).all(...(parameters as never[])) as T[];
  const projectId = one<{ id: string }>('SELECT id FROM project')!.id;
  const write = createAuthoredYjsUpdateWriter(createAuthoredTransactionRunner({
    database: () => library.client,
    identity: async () => ({
      installationId: 'v2-handoff-test',
      createWriterIdentity: () => ({ writerId: `writer-${uuidv7()}`, writerEpoch: `epoch-${uuidv7()}` }),
    }),
    clock: () => { const now = new Date(); return { nowMs: now.getTime(), nowIso: now.toISOString() }; },
    syncGenerationIds: {
      createSyncGenerationId: () => `sync-generation-${uuidv7()}`,
      createProjectSyncId: () => `project-sync-${uuidv7()}`,
    },
  }));

  const persisted = async (docId: string) =>
    (await library.client.transaction((tx) => readPersistedYjsDocuments(tx, [docId]))).get(docId)!;
  const load = async (docId: string) => {
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
    if (!found) throw new Error('no text');
    return found;
  };
  /**
   * An edit persisted the way an open editor persists it, with no contentJson
   * projection: the author quit inside the 400 ms persist debounce.
   */
  const typeWithoutProjection = async (docId: string, text: string) => {
    const doc = await load(docId);
    const before = Y.encodeStateVector(doc);
    firstText(doc).insert(0, text);
    await write(projectId, docId, Y.encodeStateAsUpdate(doc, before), { kind: 'user' });
    doc.destroy();
  };
  const docOf = (table: string, kind: string, name: string, column = 'name') =>
    `${kind}:${one<{ id: string }>(`SELECT id FROM ${table} WHERE project_id = ? AND ${column} = ?`, projectId, name)!.id}`;
  const cache = (docId: string): string | null => {
    const [kind, id] = [docId.slice(0, docId.indexOf(':')), docId.slice(docId.indexOf(':') + 1)];
    const query: Record<string, string> = {
      'node-content': 'SELECT content_json AS json FROM node_content WHERE node_id = ?',
      element: 'SELECT content_json AS json FROM element WHERE id = ?',
      storyline: 'SELECT content_json AS json FROM storylines WHERE id = ?',
      category: 'SELECT content_json AS json FROM element_category WHERE id = ?',
      'library-item': 'SELECT body_json AS json FROM library_item WHERE id = ?',
    };
    return one<{ json: string | null }>(query[kind]!, id)?.json ?? null;
  };
  const yjsDocuments = () =>
    all<{ docId: string; revision: number }>(
      `SELECT d.document_id AS docId, coalesce(r.revision, 0) AS revision
         FROM (SELECT document_id FROM yjs_updates UNION SELECT document_id FROM yjs_snapshots) d
         LEFT JOIN yjs_document_revision r ON r.document_id = d.document_id ORDER BY 1`,
    );
  const live = new Set<string>();
  let now = 0;
  const dependencies = (overrides: Partial<Dependencies> = {}): Dependencies => ({
    ...defaultV2HandoffDependencies(),
    database: () => library.client,
    appVersion: async () => '0.1.0-test',
    isLive: (docId) => live.has(docId),
    yieldToUi: async () => undefined,
    clock: () => now,
    ...overrides,
  });
  return { library, one, all, sql, projectId, write, persisted, typeWithoutProjection, docOf, cache, yjsDocuments, live, dependencies, tick: (ms: number) => { now += ms; } };
}

describe('v2 handoff', () => {
  it('makes every cache equal to its Yjs rendering and stamps it, without touching what the author sees', async () => {
    const lib = await sampleLibrary();
    const chapter = lib.docOf('book_node', 'node-content', '第四章 恋爱的悲剧', 'title');
    const element = lib.docOf('element', 'element', '赵太爷');
    const storyline = lib.docOf('storylines', 'storyline', '未庄的眼睛');
    const category = lib.docOf('element_category', 'category', '人物');
    const noteId = lib.one<{ id: string; body: string }>(
      "SELECT id, body_json AS body FROM library_item WHERE project_id = ? AND kind = 'text' AND title = ?",
      lib.projectId, '《阿Q正传》的发表',
    )!;
    const note = `library-item:${noteId.id}`;
    // A note seeds its document from bodyJson the first time it is opened.
    await lib.write(lib.projectId, note, await createYjsProseSeedState(noteId.body, 'note'), { kind: 'user' });
    const elementUpdatedAt = lib.one<{ at: string }>('SELECT updated_at AS at FROM element WHERE id = ?', element.slice('element:'.length))!.at;

    for (const docId of [chapter, element, storyline, category, note]) {
      await lib.typeWithoutProjection(docId, '〔退出前打的字〕');
      expect(lib.cache(docId)).not.toContain('〔退出前打的字〕');
    }
    globalThis.localStorage.setItem('settings-storage', '{"state":{"themeMode":"dark"},"version":31}');
    globalThis.localStorage.setItem('drifting.session_token', 'secret-token');
    const changeSets = () => lib.one<{ n: number }>('SELECT count(*) AS n FROM sync_change_set')!.n;
    const changeSetsBefore = changeSets();

    const result = await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());

    expect(result).toMatchObject({ failed: 0, orphaned: 0, deferred: 0, skippedLive: 0 });
    expect(result.refreshed).toBeGreaterThanOrEqual(5);
    const documents = lib.yjsDocuments();
    expect(result.candidates).toBe(documents.length);
    expect(result.stamped).toBe(documents.length);
    const state = (await readV2HandoffState(lib.library.client))!;
    expect(state).toMatchObject({ version: 1, appVersion: '0.1.0-test' });
    expect(Object.keys(state.documents).sort()).toEqual(documents.map((d) => d.docId));
    for (const { docId, revision } of documents) {
      const cached = lib.cache(docId)!;
      expect(cached, docId).toBe(renderPersistedProse(await lib.persisted(docId)));
      expect(state.documents[docId]).toEqual({ revision, sha256: await sha256Hex(cached) });
    }
    for (const docId of [chapter, element, storyline, category, note]) expect(lib.cache(docId)).toContain('〔退出前打的字〕');
    // The chapter's word count and basis travel with its cache.
    const basis = lib.one<{ kind: string; revision: number }>(
      'SELECT word_count_basis_kind AS kind, word_count_basis_revision AS revision FROM book_node WHERE id = ?',
      chapter.slice('node-content:'.length),
    )!;
    expect(basis).toEqual({ kind: 'yjs', revision: state.documents[chapter]!.revision });
    // Refreshing a cache is not an edit.
    expect(lib.one<{ at: string }>('SELECT updated_at AS at FROM element WHERE id = ?', element.slice('element:'.length))!.at).toBe(elementUpdatedAt);
    // Derived writes: nothing is journaled, so nothing syncs.
    expect(changeSets()).toBe(changeSetsBefore);
    // Preferences come along; the session token does not.
    expect(state.settings?.entries['settings-storage']).toBe('{"state":{"themeMode":"dark"},"version":31}');
    expect(state.settings?.entries).not.toHaveProperty('drifting.session_token');
  });

  it('revisits only documents whose revision moved, and drops documents whose owner is gone', async () => {
    const lib = await sampleLibrary();
    await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());
    const element = lib.docOf('element', 'element', '赵太爷');
    await lib.typeWithoutProjection(element, '再改一次');
    // Until the next pass the entry names an older revision, which the importer refuses.
    const stale = (await readV2HandoffState(lib.library.client))!.documents[element]!;
    expect(stale.revision).toBeLessThan(lib.yjsDocuments().find((d) => d.docId === element)!.revision);

    const orphan = `element:${uuidv7()}`;
    const doc = new Y.Doc();
    doc.getXmlFragment('default').insert(0, [new Y.XmlText('无主')]);
    lib.sql.prepare('INSERT INTO yjs_updates (document_id, update_blob, created_at) VALUES (?, ?, ?)')
      .run(orphan, Y.encodeStateAsUpdate(doc), new Date().toISOString());

    const result = await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());
    expect(result).toMatchObject({ candidates: 2, refreshed: 1, stamped: 1, orphaned: 1, failed: 0 });
    const state = (await readV2HandoffState(lib.library.client))!;
    expect(state.documents[orphan]).toBeUndefined();
    expect(state.documents[element]!.revision).toBe(lib.yjsDocuments().find((d) => d.docId === element)!.revision);
    expect(lib.cache(element)).toContain('再改一次');
  });

  it('leaves a document open in an editor to the quit pass', async () => {
    const lib = await sampleLibrary();
    const storyline = lib.docOf('storylines', 'storyline', '优胜记');
    await lib.typeWithoutProjection(storyline, '〔正在写〕');
    lib.live.add(storyline);

    const background = await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());
    expect(background.skippedLive).toBe(1);
    expect(lib.cache(storyline)).not.toContain('〔正在写〕');
    expect((await readV2HandoffState(lib.library.client))!.documents[storyline]).toBeUndefined();

    const quit = await runV2Handoff({ liveDocuments: 'include', budgetMs: 1_500 }, lib.dependencies());
    expect(quit).toMatchObject({ candidates: 1, refreshed: 1, stamped: 1 });
    expect(lib.cache(storyline)).toContain('〔正在写〕');
  });

  it('stops between batches when the budget runs out and continues on the next pass', async () => {
    const lib = await sampleLibrary();
    const total = lib.yjsDocuments().length;
    expect(total).toBeGreaterThan(16);
    const first = await runV2Handoff({ liveDocuments: 'include', budgetMs: 10 }, lib.dependencies({
      yieldToUi: async () => undefined,
      // The clock is read once per batch boundary; the third read is past the budget.
      clock: (() => { let t = 0; return () => (t += 6); })(),
    }));
    expect(first.deferred).toBeGreaterThan(0);
    expect(first.stamped).toBe(total - first.deferred);
    const second = await runV2Handoff({ liveDocuments: 'include' }, lib.dependencies());
    expect(second).toMatchObject({ candidates: first.deferred, stamped: first.deferred, deferred: 0 });
    expect(Object.keys((await readV2HandoffState(lib.library.client))!.documents)).toHaveLength(total);
  });

  it("stamps each of this library's books from WebView storage, and keeps the last books when storage is unavailable", async () => {
    const lib = await sampleLibrary();
    const [relationType] = lib.all<{ id: string }>('SELECT id FROM entity_relation_type WHERE project_id = ? ORDER BY id', lib.projectId);
    const [element] = lib.all<{ id: string }>('SELECT id FROM element WHERE project_id = ? ORDER BY id', lib.projectId);
    // WebView storage is app-wide: another library's book is in it too.
    const elsewhere = uuidv7();
    localStorage.setItem('writing-stats-storage', JSON.stringify({
      state: {
        plans: {
          [lib.projectId]: { projectWordTarget: 80000, dailyWordGoal: 0 },
          [elsewhere]: { projectWordTarget: 1000, dailyWordGoal: 10 },
        },
        history: { [lib.projectId]: { '2026-11-06': { startTotal: 1, latestTotal: 2 } } },
      },
      version: 3,
    }));
    localStorage.setItem(`drifting:edge-kind-meta:${lib.projectId}`, JSON.stringify({ v: 2, byRelationTypeId: { [relationType!.id]: { color: '#aabbcc' } } }));
    localStorage.setItem(`drifting:edge-kind-meta:${elsewhere}`, JSON.stringify({ v: 2, byRelationTypeId: { x: { color: '#000000' } } }));
    localStorage.setItem(`super-element-view:relate:${lib.projectId}`, JSON.stringify({
      v: 1, mode: 'isles', positions: { [element!.id]: [1, 1] }, pins: { [element!.id]: [12.5, -40] }, signature: 's',
    }));

    await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());
    const stamped = (await readV2HandoffState(lib.library.client))!;
    expect(stamped.books).toEqual({
      [lib.projectId]: {
        wordTarget: 80000,
        dailyWordTarget: 0,
        relationTypeColors: { [relationType!.id]: '#aabbcc' },
        elementPins: { [element!.id]: [12.5, -40] },
      },
    });
    // The raw values still travel for an importer that reads them itself.
    expect(stamped.settings?.entries[`super-element-view:relate:${lib.projectId}`]).toBeDefined();

    // No storage: the last captured books and settings stay.
    await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies({ captureSettings: () => null, captureBooks: () => null }));
    const kept = (await readV2HandoffState(lib.library.client))!;
    expect(kept.books).toEqual(stamped.books);
    expect(kept.settings).toEqual(stamped.settings);

    // Storage with nothing for these books is an empty section, not an older stamp.
    localStorage.clear();
    await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());
    expect((await readV2HandoffState(lib.library.client))!.books).toEqual({});

    // A stamp from before the section stays without one while storage is unavailable.
    lib.sql.prepare("UPDATE library_state SET value_json = json_remove(value_json, '$.books') WHERE key = 'v2-handoff'").run();
    await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies({ captureBooks: () => null }));
    const older = lib.one<{ json: string }>("SELECT value_json AS json FROM library_state WHERE key = 'v2-handoff'")!.json;
    expect(JSON.parse(older)).not.toHaveProperty('books');
  });

  it('renders a snapshot-history preview that is missing', async () => {
    const lib = await sampleLibrary();
    const chapter = lib.docOf('book_node', 'node-content', '第一章 序', 'title');
    const state = await lib.persisted(chapter);
    const doc = new Y.Doc();
    for (const update of state.updates) Y.applyUpdate(doc, update);
    const id = uuidv7();
    lib.sql.prepare(`INSERT INTO entity_snapshot_history (id, project_id, entity_kind, entity_id, state_blob, content_json, meta_json, created_at)
      VALUES (?, ?, 'node', ?, ?, NULL, '{}', ?)`).run(id, lib.projectId, chapter.slice('node-content:'.length), Y.encodeStateAsUpdate(doc), new Date().toISOString());

    const result = await runV2Handoff({ liveDocuments: 'skip' }, lib.dependencies());
    expect(result.previewsFilled).toBe(1);
    const preview = lib.one<{ json: string }>('SELECT content_json AS json FROM entity_snapshot_history WHERE id = ?', id)!.json;
    expect(preview).toBe(renderPersistedProse(state));
  });
});

describe('v2 handoff settings', () => {
  it('copies preference and layout keys, never credentials or run state', () => {
    const values = new Map<string, string>([
      ['settings-storage', '{"state":{}}'],
      ['shortcuts-storage', '{}'],
      ['plot-grid-cell-ratio:node-1', '0.4'],
      ['drifting.alpha-guide.v3:drifting-library.db', 'seen'],
      ['drifting.session_token', 'token'],
      ['drifting.dev.session_token', 'token'],
      ['drifting.hosted.profile.v1', '{"email":"a@example.com"}'],
      ['drifting.diagnostics.queue.v1', '[]'],
      ['drifting.updater.found.v1', '{}'],
      ['preference-sync-v1', '{}'],
      ['agent-edit-pending', '{}'],
    ]);
    const storage = {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
    } as Storage;
    expect(Object.keys(captureV2HandoffSettings(storage)!)).toEqual([
      'drifting.alpha-guide.v3:drifting-library.db',
      'plot-grid-cell-ratio:node-1',
      'settings-storage',
      'shortcuts-storage',
    ]);
    expect(captureV2HandoffSettings(null)).toBeNull();
  });
});
