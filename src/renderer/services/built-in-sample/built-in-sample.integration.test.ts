import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countWords, extractProseText } from '@drifting/prose-metrics';
import { v7 as uuidv7 } from 'uuid';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectAsset } from '../../domain/project-asset';
import type { DbClient } from '../../lib/db';
import { installHeadlessRendererGlobals } from '../../../dev-cli/headless-globals';

// Renderer stores read browser storage when their modules load.
installHeadlessRendererGlobals();
const { OfflineProductDatabase } = await import('../../../dev-cli/offline-database');
const { createAtomicRunner } = await import('../../../dev-cli/offline-workspace');
const {
  BUILT_IN_SAMPLE_MAX_ATTEMPTS,
  BUILT_IN_SAMPLE_STATE_KEY,
  ensureBuiltInSampleProject,
  purgeUnpublishedSampleProject,
} = await import('./built-in-sample');
const { resetBuiltInSampleForTests, startBuiltInSampleProject, useBuiltInSampleStore, waitForBuiltInSampleProject, withoutPendingSampleProject } =
  await import('./first-run');
const { BOOK_CHAPTERS, BOOK_ILLUSTRATIONS, paragraphText } = await import('./book');
const showcase = await import('./showcase');
const { LOCAL_USER_ID } = await import('../../store/auth');
const { useDataStore } = await import('../../store/data-store');
const { useProjectStore } = await import('../../store/project-store');
const { ensureLocalAuthoredAssetBlobVerified } = await import('../../sync/assets/local-authored-blob');
const { createLocalObjectRef, sha256Bytes } = await import('../../sync/protocol');
const { createSyncAppAuthorityRepository } = await import('../../sync/app-authority-repository');
const { invalidateSqliteReducerStateCache } = await import('../../sync/reducer/sqlite-materializer');
const { createProjectInTransaction } = await import('../../usecase/project-create');

type Library = InstanceType<typeof OfflineProductDatabase>;
type Dependencies = NonNullable<Parameters<typeof ensureBuiltInSampleProject>[0]>;
type Illustration = (typeof BOOK_ILLUSTRATIONS)[number];

const directories: string[] = [];
const libraries: Library[] = [];

afterEach(async () => {
  for (const library of libraries.splice(0)) await library.close();
  invalidateSqliteReducerStateCache();
  resetBuiltInSampleForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function openLibrary(): Promise<Library> {
  const directory = mkdtempSync(join(tmpdir(), 'drifting-built-in-sample-'));
  directories.push(directory);
  const library = new OfflineProductDatabase(join(directory, 'drifting-library.db'), { migrate: true });
  await library.open();
  libraries.push(library);
  return library;
}

/** The app imports bytes into the native asset store; here only the verified receipt is real. */
function memoryAssetImporter(database: DbClient, events: string[]) {
  return async (projectId: string, illustration: Illustration) => {
    const id = uuidv7();
    const asset: ProjectAsset = {
      id, projectId, kind: 'image', sourceMime: illustration.mime,
      sourceSizeBytes: illustration.sizeBytes, sourceSha256: illustration.sha256,
      width: illustration.width, height: illustration.height, createdAt: new Date().toISOString(),
    };
    await ensureLocalAuthoredAssetBlobVerified(asset, {
      database: () => database,
      nowIso: () => new Date().toISOString(),
      discardLocal: async () => undefined,
      blobPort: {
        async prepareOutbound({ syncGenerationId }) {
          const hash = `sha256:${illustration.sha256}` as const;
          return {
            sourceRef: createLocalObjectRef(`syncobj:${id}`),
            logicalKeyId: await sha256Bytes(new TextEncoder().encode(`blob/${syncGenerationId}/${hash}`)),
            storedSha256: hash, contentSha256: hash, sizeBytes: illustration.sizeBytes,
          };
        },
      },
    });
    return {
      asset,
      commit: async () => { events.push(`commit:${illustration.name}`); },
      abandon: async () => { events.push(`abandon:${illustration.name}`); },
    };
  };
}

function dependencies(library: Library, overrides: Partial<Dependencies> = {}, assetEvents: string[] = []): Dependencies {
  return {
    database: () => library.client,
    userId: LOCAL_USER_ID,
    runAtomic: createAtomicRunner(library.client),
    importAsset: memoryAssetImporter(library.client, assetEvents),
    discardProject: async (projectId) => { await purgeUnpublishedSampleProject(library.client, projectId); },
    now: () => new Date().toISOString(),
    newId: uuidv7,
    ...overrides,
  };
}

function rows<T>(library: Library, sql: string, ...parameters: string[]): T[] {
  return library.gateway.database.prepare(sql).all(...parameters) as T[];
}

function count(library: Library, sql: string, ...parameters: string[]): number {
  return Number((library.gateway.database.prepare(sql).get(...parameters) as { n: number }).n);
}

function marker(library: Library) {
  const [row] = rows<{ json: string }>(library, 'SELECT value_json AS json FROM library_state WHERE key = ?', BUILT_IN_SAMPLE_STATE_KEY);
  return row ? JSON.parse(row.json) as { status: string; projectId: string | null; attempts: number; reason?: string } : null;
}

/** The live prose of one document, rebuilt from its Yjs rows. */
function liveProse(library: Library, docId: string): { json: Record<string, unknown>; text: string } {
  const doc = new Y.Doc();
  try {
    for (const { bytes } of rows<{ bytes: Uint8Array }>(library, 'SELECT state_blob AS bytes FROM yjs_snapshots WHERE document_id = ?', docId))
      Y.applyUpdate(doc, bytes);
    for (const { bytes } of rows<{ bytes: Uint8Array }>(library, 'SELECT update_blob AS bytes FROM yjs_updates WHERE document_id = ? ORDER BY id', docId))
      Y.applyUpdate(doc, bytes);
    const json = yDocToProsemirrorJSON(doc, 'default') as Record<string, unknown>;
    return { json, text: extractProseText(json as Parameters<typeof extractProseText>[0]) };
  } finally {
    doc.destroy();
  }
}

/** Paragraph texts of a live document, top-level and inside block quotes. */
function liveParagraphs(json: Record<string, unknown>): string[] {
  const out: string[] = [];
  const text = (node: Record<string, unknown>): string =>
    node.type === 'text' ? String(node.text) : node.type === 'hardBreak' ? '\n'
      : ((node.content as Record<string, unknown>[] | undefined) ?? []).map(text).join('');
  for (const block of (json.content as Record<string, unknown>[]) ?? []) {
    if (block.type === 'blockquote') for (const child of (block.content as Record<string, unknown>[]) ?? []) out.push(text(child));
    else out.push(text(block));
  }
  return out;
}

function bundledParagraphs(number: number): string[] {
  return BOOK_CHAPTERS[number - 1].blocks.flatMap((block) => typeof block === 'string' ? [block] : [...block])
    .map((paragraph) => paragraph.replace(/\*/g, ''));
}

async function createAuthorProject(library: Library, projectId: string, name: string) {
  await createAtomicRunner(library.client)(projectId, (tx, sync, changes) =>
    createProjectInTransaction(tx, sync, changes, { projectId, userId: LOCAL_USER_ID, name, now: new Date().toISOString() }));
}

describe('built-in sample project', () => {
  it('gives an empty new library exactly one complete sample, and never brings it back after deletion', async () => {
    const library = await openLibrary();
    const assetEvents: string[] = [];
    const storesBefore = { project: useProjectStore.getState().currentProject, nodes: useDataStore.getState().bookNodes };
    let statements = 0;
    const gateway = library.gateway as unknown as Record<'execute' | 'query', (...args: unknown[]) => Promise<unknown>>;
    for (const method of ['execute', 'query'] as const) {
      const original = gateway[method].bind(library.gateway);
      gateway[method] = (...args) => { statements += 1; return original(...args); };
    }
    const steps: string[] = [];
    let counted = 0;

    const started = performance.now();
    const outcome = await ensureBuiltInSampleProject(dependencies(library, {
      onStep: (step, milliseconds) => { steps.push(`${step} ${Math.round(milliseconds)}ms/${statements - counted}sql`); counted = statements; },
    }, assetEvents));
    const elapsed = Math.round(performance.now() - started);
    expect(outcome.kind).toBe('created');
    const projectId = (outcome as { projectId: string }).projectId;
    console.info(`[built-in sample] ${elapsed} ms, ${statements} SQL statements; ${steps.join(', ')}`);

    expect(rows(library, 'SELECT id, name, user_id AS userId, deleted_at AS deletedAt FROM project')).toEqual([
      { id: projectId, name: showcase.SAMPLE_PROJECT_NAME, userId: LOCAL_USER_ID, deletedAt: null },
    ]);

    // The book: 61 chapters in reading order and three volumes as acts.
    const chapters = rows<{ id: string; title: string; words: number; status: string; bookOrder: number; narrativeOrder: number; summary: string }>(library,
      "SELECT id, title, word_count AS words, writing_status AS status, book_order AS bookOrder, narrative_order AS narrativeOrder, summary FROM book_node WHERE kind = 'chapter' ORDER BY book_order");
    expect(chapters.map((chapter) => chapter.title)).toEqual(BOOK_CHAPTERS.map((chapter) => `Chapter ${chapter.roman}`));
    expect(chapters.map((chapter) => chapter.summary)).toEqual(showcase.CHAPTER_PLANS.map((plan) => plan.summary));
    expect(chapters.filter((chapter) => chapter.status === 'finished').map((chapter) => chapter.title)).toEqual(['Chapter I']);
    expect(chapters.every((chapter) => chapter.narrativeOrder === chapter.bookOrder)).toBe(true);
    const acts = rows<{ name: string; startOrder: number }>(library, 'SELECT name, start_order AS startOrder FROM book_act ORDER BY start_order');
    expect(acts.map((act) => act.name)).toEqual(['Volume I', 'Volume II', 'Volume III']);
    const actOf = (order: number) => acts.filter((act) => act.startOrder <= order).slice(-1)[0]?.name;
    expect(chapters.map((chapter) => actOf(chapter.bookOrder))).toEqual(
      BOOK_CHAPTERS.map((chapter) => chapter.number <= 23 ? 'Volume I' : chapter.number <= 42 ? 'Volume II' : 'Volume III'));

    // Every chapter's live Yjs prose is the bundled text, and its cached count agrees.
    let totalWords = 0;
    for (const [index, chapter] of chapters.entries()) {
      const live = liveProse(library, `node-content:${chapter.id}`);
      expect(liveParagraphs(live.json), chapter.title).toEqual(bundledParagraphs(index + 1));
      expect(countWords(live.text), chapter.title).toBe(chapter.words);
      totalWords += chapter.words;
    }
    expect(totalWords).toBeGreaterThan(115_000);
    const firstChapter = liveProse(library, `node-content:${chapters[0].id}`).json;
    expect(JSON.stringify(firstChapter)).toContain('{"type":"italic"');

    // Storylines with their chapters; every chapter has a primary lane.
    const storylines = rows<{ id: string; name: string }>(library, 'SELECT id, name FROM storylines ORDER BY order_key');
    expect(storylines.map((storyline) => storyline.name)).toEqual(showcase.STORYLINES.map((storyline) => storyline.name));
    const links = rows<{ nodeId: string; storylineId: string; primary: number }>(library,
      'SELECT node_id AS nodeId, storyline_id AS storylineId, is_primary AS "primary" FROM node_storyline_link');
    expect(links).toHaveLength(showcase.CHAPTER_PLANS.reduce((sum, plan) => sum + plan.storylines.length, 0));
    expect(links.filter((link) => link.primary).length).toBe(61);
    const elizabethAndDarcy = storylines.find((storyline) => storyline.name === 'Elizabeth & Darcy')!.id;
    const chapterNumber = new Map(chapters.map((chapter, index) => [chapter.id, index + 1]));
    expect(links.filter((link) => link.storylineId === elizabethAndDarcy).map((link) => chapterNumber.get(link.nodeId)))
      .toEqual(expect.arrayContaining([3, 34, 35, 36, 43, 58]));

    // The workspace around it.
    expect(count(library, 'SELECT count(*) AS n FROM element_category')).toBe(showcase.CATEGORIES.length);
    expect(count(library, 'SELECT count(*) AS n FROM element')).toBe(showcase.ELEMENTS.length);
    expect(rows(library, "SELECT kv_json AS kv, aliases_json AS aliases FROM element WHERE name = 'Elizabeth Bennet'")).toEqual([
      { kv: JSON.stringify(showcase.ELEMENTS[0].facts), aliases: JSON.stringify(['Eliza', 'Lizzy']) },
    ]);
    expect(count(library, 'SELECT count(*) AS n FROM element WHERE portrait_asset_id IS NOT NULL')).toBe(2);
    expect(count(library, 'SELECT count(*) AS n FROM entity_relation_type')).toBe(showcase.RELATION_TYPES.length + 1);
    expect(count(library, 'SELECT count(*) AS n FROM entity_relation')).toBe(showcase.RELATIONS.length);
    expect(count(library, "SELECT count(*) AS n FROM entity_relation WHERE to_kind = 'node'")).toBe(4);
    expect(count(library, 'SELECT count(*) AS n FROM timeline_marker')).toBe(showcase.TIMELINE_PINS.length);
    expect(count(library, "SELECT count(*) AS n FROM book_node WHERE kind = 'drift'")).toBe(showcase.IDEAS.length);
    expect(count(library, 'SELECT count(*) AS n FROM element_patch WHERE source_block_id IS NOT NULL AND text_anchor_json IS NOT NULL')).toBe(showcase.ELEMENT_PATCHES.length);
    expect(rows(library, 'SELECT kind, status FROM comment ORDER BY created_at, id').length).toBe(showcase.COMMENTS.length);
    expect(count(library, "SELECT count(*) AS n FROM comment WHERE status = 'resolved'")).toBe(2);
    expect(count(library, "SELECT count(*) AS n FROM comment WHERE kind = 'todo'")).toBe(3);
    expect(count(library, "SELECT count(*) AS n FROM comment WHERE target_block_id IS NOT NULL AND author_kind = 'user'")).toBe(5);
    expect(rows(library, "SELECT body, source, status FROM agent_memory")).toEqual([{ body: showcase.PROJECT_MEMORY, source: 'author', status: 'active' }]);
    expect(rows(library, "SELECT key, value FROM entity_kv_entry WHERE owner_kind = 'project' AND namespace = 'facts' ORDER BY key"))
      .toEqual([...showcase.PROJECT_FACTS].sort((a, b) => a.key.localeCompare(b.key)));
    expect(count(library, 'SELECT count(*) AS n FROM plot_grid_cell')).toBe(15);
    expect(count(library, 'SELECT count(*) AS n FROM plot_grid_row')).toBe(4);
    expect(count(library, "SELECT count(*) AS n FROM library_item WHERE kind = 'text'")).toBe(showcase.MATERIAL_NOTES.length);
    expect(rows(library, "SELECT i.title FROM library_item i JOIN material_folder f ON f.id = i.folder_id WHERE i.kind = 'image' ORDER BY i.order_key").map((row) => (row as { title: string }).title))
      .toEqual(BOOK_ILLUSTRATIONS.filter((item) => item.use === 'material').map((item) => item.title));
    expect(count(library, 'SELECT count(*) AS n FROM project_asset')).toBe(BOOK_ILLUSTRATIONS.length);
    expect(count(library, "SELECT count(*) AS n FROM sync_blob_state WHERE local_state = 'verified'")).toBe(BOOK_ILLUSTRATIONS.length);
    expect(assetEvents.filter((event) => event.startsWith('commit:'))).toHaveLength(BOOK_ILLUSTRATIONS.length);
    expect(assetEvents.some((event) => event.startsWith('abandon:'))).toBe(false);

    // Journaled like the author's own work, in change-sets of bounded size, with nothing dangling.
    const changeSets = rows<{ bytes: number }>(library, 'SELECT length(encoded_bytes) AS bytes FROM sync_change_set');
    expect(changeSets.length).toBeGreaterThan(5);
    expect(Math.max(...changeSets.map((changeSet) => changeSet.bytes))).toBeLessThan(512 * 1024);
    expect(rows(library, 'PRAGMA foreign_key_check')).toEqual([]);
    for (const table of ['agent_conversation', 'agent_runtime_session', 'agent_runtime_turn', 'agent_runtime_tool_call', 'agent_runtime_write_effect'])
      expect(count(library, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    expect(marker(library)).toMatchObject({ status: 'created', projectId, attempts: 1 });
    expect(useProjectStore.getState().currentProject).toBe(storesBefore.project);
    expect(useDataStore.getState().bookNodes).toBe(storesBefore.nodes);
    expect(useBuiltInSampleStore.getState()).toMatchObject({ pendingProjectId: null, createdProjectId: projectId });

    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'already-created' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(1);

    // Trash it, then let it be permanently deleted: the library is empty again.
    library.gateway.database.prepare('UPDATE project SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), projectId);
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'already-created' });
    await purgeUnpublishedSampleProject(library.client, projectId);
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'already-created' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
  }, 300_000);

  it('anchors comments and patches to the exact passages in the live prose', async () => {
    const library = await openLibrary();
    const outcome = await ensureBuiltInSampleProject(dependencies(library));
    expect(outcome.kind).toBe('created');
    const anchored = [
      ...rows<{ nodeId: string; blockId: string; anchor: string }>(library,
        "SELECT target_id AS nodeId, target_block_id AS blockId, anchor_json AS anchor FROM comment WHERE target_kind = 'node'")
        .map((row) => ({ ...row, text: JSON.parse(row.anchor).textAnchor as { startOffset: number; endOffset: number; text: string } })),
      ...rows<{ nodeId: string; blockId: string; anchor: string }>(library,
        'SELECT source_node_id AS nodeId, source_block_id AS blockId, text_anchor_json AS anchor FROM element_patch')
        .map((row) => ({ ...row, text: JSON.parse(row.anchor) as { startOffset: number; endOffset: number; text: string } })),
    ];
    expect(anchored).toHaveLength(9);
    for (const { nodeId, blockId, text } of anchored) {
      const blocks = (liveProse(library, `node-content:${nodeId}`).json.content as { attrs: { id: string }; content?: { text?: string }[] }[]);
      const block = blocks.find((candidate) => candidate.attrs.id === blockId);
      expect(block, text.text).toBeDefined();
      const blockText = (block!.content ?? []).map((child) => child.text ?? '').join('');
      expect(blockText.slice(text.startOffset, text.endOffset)).toBe(text.text);
    }
    expect(paragraphText('*You* want')).toBe('You want');
  }, 300_000);

  it('never touches a library that already has projects, even in the trash or after they are gone', async () => {
    const library = await openLibrary();
    await createAuthorProject(library, 'author-book', '作者的书');
    library.gateway.database.prepare("UPDATE project SET deleted_at = '2026-10-01T00:00:00.000Z'").run();

    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'not-a-new-library' });
    expect(rows(library, 'SELECT name FROM project')).toEqual([{ name: '作者的书' }]);
    expect(marker(library)).toMatchObject({ status: 'skipped', projectId: null, attempts: 0 });

    await purgeUnpublishedSampleProject(library.client, 'author-book');
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'not-a-new-library' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
  });

  it('leaves a library that is connecting to a cloud account to that account', async () => {
    const library = await openLibrary();
    await createSyncAppAuthorityRepository(library.client).begin({
      targetMode: 'hosted', accountSubjectId: 'subject', credentialSecretRef: 'hosted.session',
      attemptId: 'connect', nowIso: new Date().toISOString(),
    });
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'not-a-new-library' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
  });

  it('rolls a failed attempt back without blocking, then retries it on a later launch', async () => {
    const library = await openLibrary();
    const assetEvents: string[] = [];
    const working = memoryAssetImporter(library.client, assetEvents);
    let imports = 0;
    const failing: Dependencies['importAsset'] = async (projectId, illustration) => {
      if (++imports === 3) throw new Error('disk full');
      return working(projectId, illustration);
    };

    const failed = await ensureBuiltInSampleProject(dependencies(library, { importAsset: failing }));
    expect(failed.kind).toBe('failed');
    for (const table of ['project', 'book_node', 'element', 'entity_kv_entry', 'library_item', 'comment', 'yjs_updates', 'agent_memory'])
      expect(count(library, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    // Imports run together; every one that succeeded is abandoned, the failed one cleaned up itself.
    expect([...assetEvents].sort()).toEqual(BOOK_ILLUSTRATIONS.map((item) => item.name)
      .filter((name) => name !== BOOK_ILLUSTRATIONS[2].name).map((name) => `abandon:${name}`).sort());
    expect(marker(library)).toMatchObject({ status: 'failed', attempts: 1, reason: 'disk full' });
    expect(useProjectStore.getState().currentProject).toBeNull();
    expect(useBuiltInSampleStore.getState().pendingProjectId).toBeNull();

    const retried = await ensureBuiltInSampleProject(dependencies(library));
    expect(retried.kind).toBe('created');
    expect(rows(library, 'SELECT name FROM project')).toEqual([{ name: showcase.SAMPLE_PROJECT_NAME }]);
    expect(count(library, "SELECT count(*) AS n FROM book_node WHERE kind = 'chapter'")).toBe(61);
    expect(marker(library)).toMatchObject({ status: 'created', attempts: 2 });
  }, 300_000);

  it('removes everything already committed when a later transaction fails', async () => {
    const library = await openLibrary();
    const assetEvents: string[] = [];
    const runner = createAtomicRunner(library.client);
    let transactions = 0;
    // The claim, the outline and the first chapter batch commit; the second batch fails.
    const runAtomic: Dependencies['runAtomic'] = (projectId, work) => {
      if (++transactions === 4) return Promise.reject(new Error('database is locked'));
      return runner(projectId, work);
    };

    const failed = await ensureBuiltInSampleProject(dependencies(library, { runAtomic }, assetEvents));
    expect(failed.kind).toBe('failed');
    for (const table of ['project', 'book_node', 'node_content', 'storylines', 'element', 'book_act', 'timeline_marker', 'yjs_updates', 'project_asset'])
      expect(count(library, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
    expect(assetEvents.filter((event) => event.startsWith('abandon:'))).toHaveLength(BOOK_ILLUSTRATIONS.length);
    expect(marker(library)).toMatchObject({ status: 'failed', attempts: 1, reason: 'database is locked' });

    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toMatchObject({ kind: 'created' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(1);
  }, 300_000);

  it('removes the partial project of an interrupted attempt before creating the sample', async () => {
    const library = await openLibrary();
    await createAuthorProject(library, 'interrupted-sample', showcase.SAMPLE_PROJECT_NAME);
    const now = new Date().toISOString();
    library.gateway.database.prepare('INSERT INTO library_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      BUILT_IN_SAMPLE_STATE_KEY,
      JSON.stringify({ status: 'creating', recipe: 'pride-and-prejudice-v1', projectId: 'interrupted-sample', attempts: 1, updatedAt: now }),
      now,
    );
    // Shelves never list the unfinished project while it is being replaced.
    useBuiltInSampleStore.setState({ pendingProjectId: 'interrupted-sample' });
    expect(withoutPendingSampleProject([{ id: 'interrupted-sample' }, { id: 'other' }])).toEqual([{ id: 'other' }]);

    const outcome = await ensureBuiltInSampleProject(dependencies(library));
    expect(outcome.kind).toBe('created');
    const projects = rows<{ id: string }>(library, 'SELECT id FROM project');
    expect(projects).toHaveLength(1);
    expect(projects[0].id).not.toBe('interrupted-sample');
    expect(marker(library)).toMatchObject({ status: 'created', attempts: 2 });
  }, 300_000);

  it('gives up after repeated failures instead of retrying forever', async () => {
    const library = await openLibrary();
    const now = new Date().toISOString();
    library.gateway.database.prepare('INSERT INTO library_state (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      BUILT_IN_SAMPLE_STATE_KEY,
      JSON.stringify({ status: 'failed', recipe: 'pride-and-prejudice-v1', projectId: null, attempts: BUILT_IN_SAMPLE_MAX_ATTEMPTS, updatedAt: now }),
      now,
    );
    await expect(ensureBuiltInSampleProject(dependencies(library))).resolves.toEqual({ kind: 'skipped', reason: 'attempts-exhausted' });
    expect(count(library, 'SELECT count(*) AS n FROM project')).toBe(0);
    expect(marker(library)).toMatchObject({ status: 'skipped', reason: 'attempts-exhausted' });
  });

  it('never rejects or blocks startup when the library cannot be read', async () => {
    // No database is open: the startup hook logs and settles, and a Hosted
    // connect waiting on it continues.
    await expect(startBuiltInSampleProject()).resolves.toBeUndefined();
    expect(startBuiltInSampleProject()).toBe(startBuiltInSampleProject());
    await expect(waitForBuiltInSampleProject()).resolves.toBeUndefined();
    expect(useBuiltInSampleStore.getState()).toMatchObject({ phase: 'settled', pendingProjectId: null, createdProjectId: null });
  });
});
