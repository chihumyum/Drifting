import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractProseText } from '@drifting/prose-metrics';
import { v7 as uuidv7 } from 'uuid';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectAsset, ProjectAssetVariant } from '../../domain/project-asset';
import { installHeadlessRendererGlobals } from '../../../dev-cli/headless-globals';

// Renderer stores read browser storage when their modules load.
installHeadlessRendererGlobals();
const { OfflineProductDatabase } = await import('../../../dev-cli/offline-database');
const { createAtomicRunner } = await import('../../../dev-cli/offline-workspace');
const { BUILT_IN_SAMPLES, ensureBuiltInSampleProject, purgeUnpublishedSampleProject } = await import('../built-in-sample/built-in-sample');
const { resetBuiltInSampleForTests } = await import('../built-in-sample/first-run');
const { BOOK_ILLUSTRATIONS } = await import('../built-in-sample/book');
const { LOCAL_USER_ID } = await import('../../store/auth');
const { ensureLocalAuthoredAssetBlobVerified } = await import('../../sync/assets/local-authored-blob');
const { captureAuthoredTablesV1 } = await import('../../sync/checkpoint/domain-catalog');
const { createLocalObjectRef, sha256Bytes } = await import('../../sync/protocol');
const { invalidateSqliteReducerStateCache } = await import('../../sync/reducer/sqlite-materializer');
const { createSyncAppAuthorityRepository } = await import('../../sync/app-authority-repository');
const { createBookElementSqliteRepository } = await import('../../sqlite-repo/element-repo');
const { deleteEntityRelationsInTransaction } = await import('../../usecase/entity-relation-cleanup');
const { projectAssetVariantExt } = await import('../asset-store.service');
const { encodeBookFile, decodeBookFile } = await import('./book-file');
const { exportBook } = await import('./export-book');
const { BookImportError, importBook } = await import('./import-book');

type Library = InstanceType<typeof OfflineProductDatabase>;
type BookImportDependencies = Parameters<typeof importBook>[1];

const SAMPLE_FILES = join(process.cwd(), 'src/renderer/services/built-in-sample/pride-and-prejudice');
const directories: string[] = [];
const libraries: Library[] = [];

afterEach(async () => {
  for (const library of libraries.splice(0)) await library.close();
  invalidateSqliteReducerStateCache();
  resetBuiltInSampleForTests();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const identity = {
  installationId: 'book-transfer-test',
  createWriterIdentity: () => ({ writerId: `writer-${uuidv7()}`, writerEpoch: `epoch-${uuidv7()}` }),
};

/**
 * A library with its own database and an in-memory asset store standing in
 * for the native one. Only the first is the renderer's database; the others
 * are reached solely through the client an import is given.
 */
async function openLibrary(options: { renderer?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'drifting-book-transfer-'));
  directories.push(directory);
  const path = join(directory, 'drifting-library.db');
  const library = new OfflineProductDatabase(path, { migrate: true });
  if (options.renderer === false) await library.gateway.open(path);
  else await library.open();
  libraries.push(library);
  const files = new Map<string, Uint8Array>();
  const events: string[] = [];
  const key = (projectId: string, assetId: string, variant: string, ext: string) =>
    `${projectId}/${assetId}/${variant}.${ext}`;
  const sourceOf = (projectId: string, assetId: string) =>
    [...files].find(([path]) => path.startsWith(`${projectId}/${assetId}/source.`))?.[1];
  const blobPort = {
    async prepareOutbound(input: { syncGenerationId: string; projectId: string; declaration: { assetId: string; blobId: string } }) {
      const bytes = sourceOf(input.projectId, input.declaration.assetId);
      if (!bytes) throw new Error(`No canonical source for ${input.declaration.assetId}`);
      const sha = await sha256Bytes(bytes);
      events.push(`prepare:${input.declaration.assetId}`);
      return {
        sourceRef: createLocalObjectRef(`syncobj:${input.declaration.assetId}`),
        logicalKeyId: await sha256Bytes(new TextEncoder().encode(`blob/${input.syncGenerationId}/${input.declaration.blobId}`)),
        storedSha256: sha,
        contentSha256: sha,
        sizeBytes: bytes.byteLength,
      };
    },
  };
  const assetStore = {
    async beginImport(_projectId: string, assetId: string) { events.push(`begin:${assetId}`); },
    async writeBytes(projectId: string, assetId: string, variant: ProjectAssetVariant, ext: string, bytes: Uint8Array) {
      files.set(key(projectId, assetId, variant, ext), new Uint8Array(bytes));
    },
    async commitImport(_projectId: string, assetId: string) { events.push(`commit:${assetId}`); },
    async deleteAsset(projectId: string, assetId: string) {
      for (const path of [...files.keys()]) if (path.startsWith(`${projectId}/${assetId}/`)) files.delete(path);
      events.push(`delete:${assetId}`);
    },
  };
  const readAssetVariant = async (projectId: string, asset: ProjectAsset, variant: ProjectAssetVariant) =>
    files.get(key(projectId, asset.id, variant, projectAssetVariantExt(asset, variant))) ?? null;
  const discarded: string[] = [];
  const committed: string[] = [];
  const importDependencies = (overrides: Partial<BookImportDependencies> = {}): BookImportDependencies => ({
    database: library.client,
    localUserId: LOCAL_USER_ID,
    identity: async () => identity,
    clock: () => {
      const now = new Date();
      return { nowMs: now.getTime(), nowIso: now.toISOString() };
    },
    newId: uuidv7,
    assetStore,
    blobPort,
    discardLocalObject: async (sourceRef) => { discarded.push(sourceRef); },
    onCommitted: (event) => committed.push(event.changeSetId),
    ...overrides,
  });
  const exportDependencies = { database: library.client, readAssetVariant, newId: uuidv7, now: () => new Date() };
  return { library, files, events, discarded, committed, blobPort, assetStore, importDependencies, exportDependencies };
}

type TestLibrary = Awaited<ReturnType<typeof openLibrary>>;

/** The first built-in sample (Pride and Prejudice), its illustrations written into the library's asset store. */
async function writeSample(target: TestLibrary): Promise<string> {
  const outcome = await ensureBuiltInSampleProject({
    samples: BUILT_IN_SAMPLES.slice(0, 1),
    database: () => target.library.client,
    userId: LOCAL_USER_ID,
    runAtomic: createAtomicRunner(target.library.client),
    async importAsset(projectId, illustration) {
      const id = uuidv7();
      const source = new Uint8Array(readFileSync(join(SAMPLE_FILES, illustration.source)));
      await target.assetStore.writeBytes(projectId, id, 'source', 'jpg', source);
      for (const [variant, { file }] of Object.entries(illustration.variants)) {
        await target.assetStore.writeBytes(projectId, id, variant as ProjectAssetVariant, 'jpg', readFileSync(join(SAMPLE_FILES, file)));
      }
      const asset: ProjectAsset = {
        id, projectId, kind: 'image', sourceMime: illustration.mime, sourceSizeBytes: illustration.sizeBytes,
        sourceSha256: illustration.sha256, width: illustration.width, height: illustration.height,
        createdAt: new Date().toISOString(),
      };
      await ensureLocalAuthoredAssetBlobVerified(asset, {
        database: () => target.library.client,
        nowIso: () => new Date().toISOString(),
        discardLocal: async () => undefined,
        blobPort: target.blobPort as never,
      });
      return { asset, commit: async () => undefined, abandon: async () => undefined };
    },
    discardProject: async (projectId) => { await purgeUnpublishedSampleProject(target.library.client, projectId); },
    now: () => new Date().toISOString(),
    newId: uuidv7,
  });
  expect(outcome.kind).toBe('created');
  return (outcome as { projectId: string }).projectId;
}

function rows<T>(library: Library, sql: string, ...parameters: string[]): T[] {
  return library.gateway.database.prepare(sql).all(...parameters) as T[];
}

/** Every authored row of one project, as a checkpoint captures it. */
async function authoredState(library: Library, projectId: string) {
  return library.client.transaction((tx) => captureAuthoredTablesV1(tx, projectId));
}

function replaceIds(text: string, identities: ReadonlyMap<string, string>): string {
  let result = text;
  for (const [from, to] of identities) result = result.split(from).join(to);
  return result;
}

/** Tables as comparable text: rows sorted after any id rewrite. */
function canonicalTables(tables: Awaited<ReturnType<typeof authoredState>>, identities?: ReadonlyMap<string, string>) {
  return Object.fromEntries(tables.map(({ table, rows: tableRows }) => [
    table,
    tableRows
      .map((row) => {
        const json = JSON.stringify(row, (_key, value: unknown) => (value instanceof Uint8Array ? [...value] : value));
        return identities ? replaceIds(json, identities) : json;
      })
      .sort(),
  ]));
}

function allIdValues(tables: Awaited<ReturnType<typeof authoredState>>): Set<string> {
  const ids = new Set<string>();
  for (const { rows: tableRows } of tables) for (const row of tableRows) if (typeof row.id === 'string') ids.add(row.id);
  return ids;
}

function liveProse(library: Library, docId: string): Record<string, unknown> | null {
  const states = [
    ...rows<{ bytes: Uint8Array }>(library, 'SELECT state_blob AS bytes FROM yjs_snapshots WHERE document_id = ?', docId),
    ...rows<{ bytes: Uint8Array }>(library, 'SELECT update_blob AS bytes FROM yjs_updates WHERE document_id = ? ORDER BY id', docId),
  ];
  if (states.length === 0) return null;
  const doc = new Y.Doc();
  try {
    for (const { bytes } of states) Y.applyUpdate(doc, bytes);
    return yDocToProsemirrorJSON(doc, 'default') as Record<string, unknown>;
  } finally {
    doc.destroy();
  }
}

function proseDocIds(library: Library, projectId: string): string[] {
  const nodes = rows<{ id: string }>(library, 'SELECT id FROM book_node WHERE project_id = ?', projectId).map(({ id }) => `node-content:${id}`);
  const elements = rows<{ id: string }>(library, 'SELECT id FROM element WHERE project_id = ?', projectId).map(({ id }) => `element:${id}`);
  const storylines = rows<{ id: string }>(library, 'SELECT id FROM storylines WHERE project_id = ?', projectId).map(({ id }) => `storyline:${id}`);
  const categories = rows<{ id: string }>(library, 'SELECT id FROM element_category WHERE project_id = ?', projectId).map(({ id }) => `category:${id}`);
  const notes = rows<{ id: string }>(library, "SELECT id FROM library_item WHERE project_id = ? AND kind = 'text'", projectId).map(({ id }) => `library-item:${id}`);
  return [...nodes, ...elements, ...storylines, ...categories, ...notes];
}

/** Projection columns rebuilt from reducer authority, keyed by the copy's ids. */
function projections(library: Library, projectId: string, identities?: ReadonlyMap<string, string>) {
  const map = (value: string) => (identities ? replaceIds(value, identities) : value);
  const keyed = (sql: string) => Object.fromEntries(
    rows<Record<string, unknown>>(library, sql, projectId).map((row) => [map(String(row.id)), map(JSON.stringify(row))]),
  );
  return {
    project: keyed('SELECT id, kv_json, storyline_template_kv_json FROM project WHERE id = ?'),
    storylines: keyed('SELECT id, order_key, kv_json FROM storylines WHERE project_id = ?'),
    groups: keyed('SELECT id, sort_order FROM drift_group WHERE project_id = ?'),
    elements: keyed('SELECT id, kv_json, aliases_json, portrait_asset_id FROM element WHERE project_id = ?'),
    categories: keyed('SELECT id, element_template_kv_json FROM element_category WHERE project_id = ?'),
    patches: keyed('SELECT id, order_key FROM element_patch WHERE project_id = ?'),
    library: keyed('SELECT id, order_key, asset_id FROM library_item WHERE project_id = ?'),
    grids: keyed('SELECT n.id AS id, c.plot_grid_json FROM node_content c JOIN book_node n ON n.id = c.node_id WHERE n.project_id = ? AND c.plot_grid_json IS NOT NULL'),
    links: keyed("SELECT node_id || '/' || storyline_id AS id, is_primary FROM node_storyline_link WHERE node_id IN (SELECT id FROM book_node WHERE project_id = ?)"),
  };
}

async function trashOneElement(target: TestLibrary, projectId: string): Promise<string> {
  const [element] = rows<{ id: string }>(
    target.library,
    'SELECT id FROM element WHERE project_id = ? AND portrait_asset_id IS NOT NULL ORDER BY id LIMIT 1',
    projectId,
  );
  await createAtomicRunner(target.library.client)(projectId, async (tx, sync) => {
    await deleteEntityRelationsInTransaction(tx, sync, projectId, 'element', element!.id);
    await createBookElementSqliteRepository(projectId, tx).softDelete(element!.id);
    await sync('element', 'softDelete', element!.id, projectId);
  });
  return element!.id;
}

describe('book transfer between libraries', () => {
  it('imports an exported book into another library as a new book with fresh identities', async () => {
    const source = await openLibrary();
    const sourceProjectId = await writeSample(source);
    const trashedElementId = await trashOneElement(source, sourceProjectId);
    const sourceState = await authoredState(source.library, sourceProjectId);
    const sourceIds = allIdValues(sourceState);

    const staged = source.events.length;
    const exported = await exportBook(sourceProjectId, source.exportDependencies);
    // Exporting stages nothing in the source library's sync object store.
    expect(source.events.length).toBe(staged);
    expect(exported.fileName).toMatch(/\.driftingbook$/u);
    const file = decodeBookFile(exported.bytes);
    expect(file.assets).toHaveLength(BOOK_ILLUSTRATIONS.length);
    expect(file.assets.every((asset) => asset.variants.map((variant) => variant.variant).sort().join() === 'display,source,thumbnail')).toBe(true);

    const target = await openLibrary({ renderer: false });
    const imported = await importBook(exported.bytes, target.importDependencies());
    expect(imported.projectId).not.toBe(sourceProjectId);
    expect(imported.title).toBe(exported.title);

    // Every authored row came across, with every identity replaced.
    const copyState = await authoredState(target.library, imported.projectId);
    expect(canonicalTables(copyState)).toEqual(canonicalTables(sourceState, imported.identities));
    const copyText = JSON.stringify(canonicalTables(copyState));
    for (const id of sourceIds) expect(copyText.includes(id), id).toBe(false);
    expect([...imported.identities.keys()].sort()).toEqual([...sourceIds].sort());
    expect(new Set(imported.identities.values()).size).toBe(sourceIds.size);

    // Projections rebuilt from the replayed reducer state match the original.
    expect(projections(target.library, imported.projectId)).toEqual(
      projections(source.library, sourceProjectId, imported.identities),
    );

    // Live prose, marks and entity links included, follows the new ids.
    const docIds = proseDocIds(source.library, sourceProjectId);
    expect(docIds.length).toBeGreaterThan(20);
    let withProse = 0;
    for (const docId of docIds) {
      const original = liveProse(source.library, docId);
      const copy = liveProse(target.library, replaceIds(docId, imported.identities));
      if (original === null) {
        expect(copy).toBeNull();
        continue;
      }
      withProse += 1;
      expect(copy).toEqual(JSON.parse(replaceIds(JSON.stringify(original), imported.identities)));
      expect(extractProseText(copy as never)).toBe(extractProseText(original as never));
    }
    expect(withProse).toBeGreaterThan(10);

    // Assets: every variant's bytes, under new asset ids, with verified receipts.
    const copyAssets = rows<{ id: string; sha: string }>(target.library, 'SELECT id, source_sha256 AS sha FROM project_asset WHERE project_id = ?', imported.projectId);
    expect(copyAssets).toHaveLength(BOOK_ILLUSTRATIONS.length);
    for (const asset of copyAssets) {
      const stored = [...target.files].filter(([path]) => path.startsWith(`${imported.projectId}/${asset.id}/`));
      expect(stored.map(([path]) => path.split('/').pop()).sort()).toEqual(['display.jpg', 'source.jpg', 'thumbnail.jpg']);
      const sourceBytes = stored.find(([path]) => path.endsWith('/source.jpg'))![1];
      expect(await sha256Bytes(sourceBytes)).toBe(`sha256:${asset.sha}`);
      expect(target.events).toContain(`commit:${asset.id}`);
    }
    const [generation] = rows<{ id: string; status: string }>(target.library, 'SELECT sync_generation_id AS id, status FROM sync_generation WHERE project_id = ?', imported.projectId);
    expect(generation?.status).toBe('active');
    expect(rows<{ state: string }>(target.library, 'SELECT local_state AS state FROM sync_blob_state WHERE sync_generation_id = ?', generation!.id).map(({ state }) => state))
      .toEqual(copyAssets.map(() => 'verified'));

    // A fresh local journal: the creates, then the trash, both this installation's own.
    const changeSets = rows<{ origin: string; seq: number }>(target.library, 'SELECT origin, device_seq AS seq FROM sync_change_set WHERE sync_generation_id = ? ORDER BY device_seq', generation!.id);
    expect(changeSets).toEqual([{ origin: 'local', seq: 1 }, { origin: 'local', seq: 2 }]);
    expect(target.committed).toHaveLength(2);
    const trashedCopy = imported.identities.get(trashedElementId)!;
    expect(rows<{ state: string }>(target.library, "SELECT state FROM sync_entity_lifecycle WHERE sync_generation_id = ? AND entity_kind = 'element' AND entity_id = ?", generation!.id, trashedCopy))
      .toEqual([{ state: 'trashed' }]);
    expect(rows<{ deletedAt: string | null }>(target.library, 'SELECT deleted_at AS deletedAt FROM element WHERE id = ?', trashedCopy)[0]?.deletedAt).not.toBeNull();

    // The copy is an ordinary project: it exports again, and that file imports too.
    const again = await exportBook(imported.projectId, target.exportDependencies);
    const third = await openLibrary({ renderer: false });
    const reimported = await importBook(again.bytes, third.importDependencies());
    const thirdState = await authoredState(third.library, reimported.projectId);
    expect(canonicalTables(thirdState)).toEqual(canonicalTables(copyState, reimported.identities));
  }, 120_000);

  it('imports the same file twice, and back into its own library, without sharing an id', async () => {
    const source = await openLibrary();
    const sourceProjectId = await writeSample(source);
    const exported = await exportBook(sourceProjectId, source.exportDependencies);

    const first = await importBook(exported.bytes, source.importDependencies());
    const second = await importBook(exported.bytes, source.importDependencies());
    const projects = rows<{ id: string }>(source.library, 'SELECT id FROM project ORDER BY id').map(({ id }) => id);
    expect(new Set(projects)).toEqual(new Set([sourceProjectId, first.projectId, second.projectId]));
    const firstIds = new Set(first.identities.values());
    for (const id of second.identities.values()) expect(firstIds.has(id)).toBe(false);

    const original = canonicalTables(await authoredState(source.library, sourceProjectId));
    expect(canonicalTables(await authoredState(source.library, first.projectId))).toEqual(
      canonicalTables(await authoredState(source.library, sourceProjectId), first.identities),
    );
    expect(canonicalTables(await authoredState(source.library, second.projectId))).toEqual(
      canonicalTables(await authoredState(source.library, sourceProjectId), second.identities),
    );
    // The original is untouched.
    expect(canonicalTables(await authoredState(source.library, sourceProjectId))).toEqual(original);
  }, 120_000);

  it('stages the imported book for publishing when the library belongs to an account', async () => {
    const source = await openLibrary();
    const exported = await exportBook(await writeSample(source), source.exportDependencies);
    const target = await openLibrary({ renderer: false });
    // The account library's own connect: nothing to restore, one provider account.
    const authority = createSyncAppAuthorityRepository(target.library.client);
    const nowIso = new Date().toISOString();
    const attempt = await authority.begin({
      targetMode: 'hosted',
      accountSubjectId: 'synthetic-subject',
      credentialSecretRef: 'secret:synthetic',
      nowIso,
    });
    await authority.complete({ attemptId: attempt.attemptId, providerAccountId: 'hosted-account', bindings: [], nowIso });
    const requested: number[] = [];

    const imported = await importBook(exported.bytes, target.importDependencies({
      assertStorageAllows: async (bytes) => { requested.push(bytes); },
    }));

    expect(requested).toEqual([BOOK_ILLUSTRATIONS.reduce((total, illustration) => total + illustration.sizeBytes, 0)]);
    const [generation] = rows<{ id: string }>(target.library, 'SELECT sync_generation_id AS id FROM sync_generation WHERE project_id = ?', imported.projectId);
    expect(rows(target.library, 'SELECT provider_account_id AS account, state FROM sync_provider_binding WHERE sync_generation_id = ?', generation!.id))
      .toEqual([{ account: 'hosted-account', state: 'connecting' }]);
    // Its assets still have to be uploaded, like any asset written here.
    expect(new Set(rows<{ remote: string }>(target.library, 'SELECT remote_state AS remote FROM sync_blob_state WHERE sync_generation_id = ?', generation!.id).map(({ remote }) => remote)))
      .toEqual(new Set(['missing']));
  }, 120_000);

  it('rejects a book whose asset bytes do not match, and leaves the library as it was', async () => {
    const source = await openLibrary();
    const exported = await exportBook(await writeSample(source), source.exportDependencies);
    const file = decodeBookFile(exported.bytes);
    const [first, ...rest] = file.assets;
    const corrupt = encodeBookFile({
      ...file,
      assets: [{
        ...first!,
        variants: first!.variants.map((variant) => variant.variant === 'source'
          ? { ...variant, bytes: Uint8Array.from(variant.bytes, (byte, index) => (index === 100 ? byte ^ 0xff : byte)) }
          : variant),
      }, ...rest],
    });

    const target = await openLibrary({ renderer: false });
    await expect(importBook(corrupt, target.importDependencies())).rejects.toMatchObject({ code: 'invalid' });
    await expect(importBook(new TextEncoder().encode('not a book'), target.importDependencies())).rejects.toMatchObject({ code: 'not-a-book' });
    await expect(importBook(encodeBookFile({ ...file, version: 2 as never }), target.importDependencies())).rejects.toMatchObject({ code: 'newer' });
    expect(rows(target.library, 'SELECT id FROM project')).toEqual([]);
    expect(target.files.size).toBe(0);
    expect(target.events).toEqual([]);
  }, 120_000);

  it('rolls back the rows, the asset files and the staged blobs when activation fails', async () => {
    const source = await openLibrary();
    const exported = await exportBook(await writeSample(source), source.exportDependencies);
    const target = await openLibrary({ renderer: false });
    const failing = target.importDependencies({
      // No change-set can be recorded: activation fails after rows, prose and receipts were written.
      identity: async () => ({ ...identity, createWriterIdentity: () => ({ writerId: 'bad writer id', writerEpoch: 'epoch' }) }),
    });

    const error = await importBook(exported.bytes, failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BookImportError);
    expect((error as InstanceType<typeof BookImportError>).code).toBe('failed');
    for (const table of ['project', 'book_node', 'element', 'project_asset', 'yjs_updates', 'sync_change_set', 'sync_blob_state', 'sync_generation']) {
      expect(rows(target.library, `SELECT 1 FROM ${table}`), table).toEqual([]);
    }
    expect(target.files.size).toBe(0);
    expect(target.discarded).toHaveLength(BOOK_ILLUSTRATIONS.length);
    expect(target.events.filter((event) => event.startsWith('delete:'))).toHaveLength(BOOK_ILLUSTRATIONS.length);
  }, 120_000);
});
