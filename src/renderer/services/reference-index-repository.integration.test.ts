import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { STRUCTURAL_ENTITY_KINDS, type StructuralEntityKind } from '../domain/entity-kinds';
import type { DbClient } from '../lib/db';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { PROSE_ENTITY_TYPES, proseDocId } from '../lib/yjs-doc-id';
import {
  BookElementTable, BookNodeTable, ElementCategoryTable, ElementPatchTable,
  InlineMentionTable, NodeContentTable, ProjectTable, StorylineTable, SyncGenerationTable,
  YjsDocumentRevisionTable,
} from '../schema/drizzle';
import { createInlineMentionRepository } from '../sqlite-repo/inline-mention-repo';
import { createYjsRepository } from '../sqlite-repo/yjs-repo';
import { ensureActiveSyncGenerationInTransaction } from '../sync/journal/sync-generation-repository';
import {
  createReferenceIndexRepository, ReferenceIndexOwnerInactiveError,
  sameReferenceIndexScope, sameReferenceSourceVersion,
  type PreparedReferenceSource, type ReferenceIndexCatalog,
} from './reference-index-repository';
import { flushPendingAtomicSyncTransactions } from './atomic-sync-transaction-tracker';

const NOW = '2026-09-12T00:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];

function json(target = 'cached-target') {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'block-1' }, content: [
    { type: 'text', text: 'Synthetic reference', marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId: target } }] },
  ] }] });
}

function ydoc(target = 'durable-target') {
  const doc = new Y.Doc({ gc: false });
  const block = new Y.XmlElement('paragraph');
  block.setAttribute('id', 'block-1');
  const text = new Y.XmlText();
  text.insert(0, 'Synthetic reference', { entityLink: { targetKind: 'element', targetId: target } });
  block.insert(0, [text]);
  doc.getXmlFragment('default').insert(0, [block]);
  cleanups.push(async () => doc.destroy());
  return { doc, text };
}

async function seedProject(db: DbClient, projectId: string) {
  await db.insert(ProjectTable).values({ id: projectId, userId: 'synthetic-user', name: 'Synthetic project', createdAt: NOW, updatedAt: NOW });
}

async function seedSources(db: DbClient, projectId: string, suffix = '') {
  const common = { projectId, createdAt: NOW, updatedAt: NOW };
  await db.insert(BookNodeTable).values({ ...common, id: `node${suffix}`, title: 'Synthetic chapter', positionX: 0, positionY: 0 });
  await db.insert(NodeContentTable).values({ nodeId: `node${suffix}`, contentJson: json(), outlineJson: '[]', plotGridJson: '{}', createdAt: NOW, updatedAt: NOW });
  await db.insert(BookElementTable).values({ ...common, id: `element${suffix}`, name: 'Synthetic element', contentJson: json() });
  await db.insert(ElementCategoryTable).values({ ...common, id: `category${suffix}`, name: 'Synthetic category', color: '#000000', contentJson: json() });
  await db.insert(StorylineTable).values({ ...common, id: `storyline${suffix}`, name: 'Synthetic storyline', color: '#000000', orderKey: 0, contentJson: json() });
  await db.insert(ElementPatchTable).values({ ...common, id: `patch${suffix}`, elementId: `element${suffix}`, contentJson: json() });
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-reference-index-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  const db = gateway.client();
  await seedProject(db, 'project-a');
  await seedSources(db, 'project-a');
  let active = true;
  const repo = createReferenceIndexRepository({ database: db, projectId: 'project-a', isCurrent: () => active });
  return { gateway, db, repo, revoke: () => { active = false; } };
}

async function prepare(repo: ReturnType<typeof createReferenceIndexRepository>, kind: StructuralEntityKind = 'node', catalog?: ReferenceIndexCatalog) {
  const captured = catalog ?? await repo.captureCatalog();
  expect(captured).not.toBeNull();
  const source = captured!.sources.find((row) => row.kind === kind)!;
  expect(source).toBeDefined();
  const prepared = await repo.prepareSource(captured!.scope, source);
  expect(prepared).not.toBeNull();
  return prepared!;
}

async function mentions(db: DbClient) {
  return db.select().from(InlineMentionTable);
}

async function replaceAll(repo: ReturnType<typeof createReferenceIndexRepository>) {
  const catalog = (await repo.captureCatalog())!;
  for (const source of catalog.sources) {
    const prepared = await repo.prepareSource(catalog.scope, source);
    expect(prepared).not.toBeNull();
    expect(await repo.replaceSource(prepared!)).toBe(true);
  }
  return catalog;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('reference index durable transaction boundary', () => {
  it('captures only requested source metadata and coverage without loading snapshot blobs or another project', async () => {
    const { db, gateway, repo } = await fixture();
    await seedProject(db, 'project-b'); await seedSources(db, 'project-b', '-foreign');
    await createYjsRepository(db).upsertSnapshot('node-content:node', Y.encodeStateAsUpdate(ydoc().doc), { advanceRevision: false });
    await createYjsRepository(db).appendUpdate('node-content:node-foreign', Y.encodeStateAsUpdate(ydoc('foreign').doc));
    await replaceAll(repo);
    const columns: string[][] = [];
    const query = gateway.query.bind(gateway);
    vi.spyOn(gateway, 'query').mockImplementation(async (...args) => {
      const result = await query(...args); columns.push([...result.columns]); return result;
    });
    const catalog = (await repo.captureCatalog([{ kind: 'node', id: 'node' }, { kind: 'patch', id: 'patch' }]))!;
    expect(catalog.sources.map((source) => source.id)).toEqual(['node', 'patch']);
    expect(catalog.sources[0]!.basis).toEqual({ kind: 'yjs', revision: 0, hasState: true });
    expect(catalog.indexedCounts.size).toBe(2);
    expect(columns.flat()).not.toContain('state_blob');
    expect(await createYjsRepository(db).hasDocState('node-content:node')).toBe(true);
    expect(columns.flat()).not.toContain('state_blob');
    const foreign = (await repo.captureCatalog([{ kind: 'node', id: 'node-foreign' }]))!;
    expect(foreign.sources).toEqual([]);
    expect(foreign.indexedCounts.size).toBe(0);
    expect(await createYjsRepository(db).listDocIds([])).toEqual([]);
    expect(await createYjsRepository(db).listRevisions([])).toEqual([]);
    await expect(repo.captureCatalog([])).rejects.toThrow('at least one');
  });
  it('drains failed derived replacements without failing an unrelated author-state barrier', async () => {
    const { repo, gateway } = await fixture();
    const prepared = await prepare(repo);
    gateway.failNextExecute((sql) => sql.startsWith('insert into "inline_mention"'));
    const replace = repo.replaceSource(prepared);
    const drain = flushPendingAtomicSyncTransactions();
    await expect(replace).rejects.toThrow();
    await expect(drain).resolves.toBeUndefined();
  });
  it('captures all five source kinds and projects JSON seeds without writing author state', async () => {
    const { db, repo } = await fixture();
    const catalog = await replaceAll(repo);
    expect(catalog.sources.map((source) => source.kind).sort()).toEqual([...STRUCTURAL_ENTITY_KINDS].sort());
    expect(catalog.sources.every((source) => source.basis.kind === 'json')).toBe(true);
    expect((await mentions(db)).map((row) => row.toId)).toEqual(Array(5).fill('cached-target'));
    expect(await createYjsRepository(db).listRevisions()).toEqual([]);
    expect((await db.select().from(NodeContentTable))[0]!.contentJson).toBe(json());
    expect(catalog.scope.generation).toBeNull();
  });

  it.each(PROSE_ENTITY_TYPES)('reads durable %s Yjs instead of a stale or invalid JSON cache', async (kind) => {
    const { db, repo } = await fixture();
    const { doc } = ydoc();
    const yjs = createYjsRepository(db);
    await yjs.appendUpdate(proseDocId(kind, kind), Y.encodeStateAsUpdate(doc));
    if (kind === 'node') await db.update(NodeContentTable).set({ contentJson: '{invalid-cache' });
    const prepared = await prepare(repo, kind);
    expect(prepared.source.basis).toEqual({ kind: 'yjs', revision: 1, hasState: true });
    expect(prepared.drafts.map((draft) => draft.toId)).toEqual(['durable-target']);
    expect(await repo.replaceSource(prepared)).toBe(true);
    expect((await mentions(db))[0]!.toId).toBe('durable-target');
    expect(await yjs.getRevision(proseDocId(kind, kind))).toBe(1);
    expect(await yjs.getSnapshot(proseDocId(kind, kind))).toBeNull();
  });

  it('combines snapshots and updates and keeps the same source version through compaction', async () => {
    const { db, repo } = await fixture();
    const { doc, text } = ydoc('snapshot-target');
    const yjs = createYjsRepository(db);
    await yjs.upsertSnapshot('node-content:node', Y.encodeStateAsUpdate(doc));
    const vector = Y.encodeStateVector(doc);
    text.format(0, text.length, { entityLink: { targetKind: 'element', targetId: 'updated-target' } });
    await yjs.appendUpdate('node-content:node', Y.encodeStateAsUpdate(doc, vector));
    const prepared = await prepare(repo);
    expect(prepared.drafts[0]!.toId).toBe('updated-target');
    await db.transaction(async (tx) => {
      const bound = createYjsRepository(tx);
      await bound.upsertSnapshot('node-content:node', Y.encodeStateAsUpdate(doc), { advanceRevision: false });
      await bound.deleteUpdatesUpTo('node-content:node', await bound.maxUpdateId('node-content:node'));
    });
    const compacted = await prepare(repo);
    expect(sameReferenceSourceVersion(prepared.source, compacted.source)).toBe(true);
    expect(await repo.replaceSource(prepared)).toBe(true);
    expect((await mentions(db))[0]!.toId).toBe('updated-target');
  });

  it('distinguishes a revision-zero snapshot from a JSON seed', async () => {
    const { db, repo } = await fixture();
    const seed = await prepare(repo);
    await createYjsRepository(db).upsertSnapshot('node-content:node', Y.encodeStateAsUpdate(ydoc().doc), { advanceRevision: false });
    expect(await repo.replaceSource(seed)).toBe(false);
    const current = await prepare(repo);
    expect(current.source.basis).toEqual({ kind: 'yjs', revision: 0, hasState: true });
    expect(current.drafts[0]!.toId).toBe('durable-target');
  });

  it('ignores metadata and materialized-cache changes but detects only the changed prose source', async () => {
    const { db, repo } = await fixture();
    const { doc, text } = ydoc();
    const yjs = createYjsRepository(db);
    await yjs.appendUpdate('node-content:node', Y.encodeStateAsUpdate(doc));
    const before = (await repo.captureCatalog())!;
    await db.update(BookNodeTable).set({ title: 'Renamed', positionX: 20, wordCount: 200 });
    await db.update(NodeContentTable).set({ contentJson: json('new-cache') });
    await db.update(BookElementTable).set({ name: 'Renamed element', updatedAt: 'later' });
    const metadata = (await repo.captureCatalog())!;
    expect(metadata.sources.every((source, index) => sameReferenceSourceVersion(source, before.sources[index]!))).toBe(true);
    const vector = Y.encodeStateVector(doc);
    text.insert(text.length, '!');
    await yjs.appendUpdate('node-content:node', Y.encodeStateAsUpdate(doc, vector));
    const prose = (await repo.captureCatalog())!;
    expect(prose.sources.filter((source, index) => !sameReferenceSourceVersion(source, metadata.sources[index]!)).map((source) => source.kind)).toEqual(['node']);
  });

  it('detects JSON source changes even when updatedAt is unchanged', async () => {
    const { db, repo } = await fixture();
    const stale = await prepare(repo, 'patch');
    await db.update(ElementPatchTable).set({ contentJson: json('new-target') });
    expect(await repo.prepareSource(stale.scope, stale.source)).toBeNull();
    expect(await repo.replaceSource(stale)).toBe(false);
    const current = await prepare(repo, 'patch');
    expect(sameReferenceSourceVersion(stale.source, current.source)).toBe(false);
    expect(current.drafts[0]!.toId).toBe('new-target');
  });

  it('never falls back to JSON when a durable revision has lost its Yjs state', async () => {
    const { db, repo } = await fixture();
    await repo.replaceSource(await prepare(repo));
    const old = await mentions(db);
    await db.insert(YjsDocumentRevisionTable).values({ docId: 'node-content:node', revision: 2, updatedAt: NOW });
    await expect(prepare(repo)).rejects.toThrow('no Yjs state');
    expect(await mentions(db)).toEqual(old);
  });

  it('preserves previous references when JSON parsing fails', async () => {
    const { db, repo } = await fixture();
    await repo.replaceSource(await prepare(repo));
    const old = await mentions(db);
    await db.update(NodeContentTable).set({ contentJson: '{invalid' });
    await expect(prepare(repo)).rejects.toThrow();
    expect(await mentions(db)).toEqual(old);
  });

  it('preserves previous references when persisted Yjs bytes are malformed', async () => {
    const { db, repo } = await fixture();
    await repo.replaceSource(await prepare(repo));
    const old = await mentions(db);
    await createYjsRepository(db).appendUpdate('node-content:node', new Uint8Array([255]));
    await expect(prepare(repo)).rejects.toThrow();
    expect(await mentions(db)).toEqual(old);
  });

  it('rejects unresolved Yjs dependencies instead of indexing a partial document', async () => {
    const { db, repo } = await fixture();
    const { doc, text } = ydoc();
    const vector = Y.encodeStateVector(doc);
    text.insert(text.length, '!');
    await createYjsRepository(db).appendUpdate('node-content:node', Y.encodeStateAsUpdate(doc, vector));
    await expect(prepare(repo)).rejects.toThrow('unresolved update dependencies');
    expect(await mentions(db)).toEqual([]);
  });

  it('rejects late preparation and replacement after a newer durable prose revision', async () => {
    const { db, repo } = await fixture();
    const { doc, text } = ydoc('first-target');
    const yjs = createYjsRepository(db);
    await yjs.appendUpdate('node-content:node', Y.encodeStateAsUpdate(doc));
    const old = await prepare(repo);
    const vector = Y.encodeStateVector(doc);
    text.format(0, text.length, { entityLink: { targetKind: 'element', targetId: 'newer-target' } });
    await yjs.appendUpdate('node-content:node', Y.encodeStateAsUpdate(doc, vector));
    expect(await repo.replaceSource(await prepare(repo))).toBe(true);
    const currentRows = await mentions(db);
    expect(await repo.prepareSource(old.scope, old.source)).toBeNull();
    expect(await repo.replaceSource(old)).toBe(false);
    expect(await mentions(db)).toEqual(currentRows);
    expect(currentRows[0]!.toId).toBe('newer-target');
  });

  it('invalidates both generation creation and generation replacement without mutating generations', async () => {
    const { db, repo } = await fixture();
    const noGeneration = await prepare(repo);
    await db.transaction((tx) => ensureActiveSyncGenerationInTransaction(tx, {
      projectId: 'project-a', nowIso: NOW,
      ids: { createProjectSyncId: () => 'project-sync-a', createSyncGenerationId: () => 'generation-a' },
    }));
    const firstGeneration = await prepare(repo);
    expect(sameReferenceIndexScope(noGeneration.scope, firstGeneration.scope)).toBe(false);
    expect(await repo.replaceSource(noGeneration)).toBe(false);
    await db.transaction(async (tx) => {
      await tx.update(SyncGenerationTable).set({ status: 'retired', retiredAt: NOW })
        .where(eq(SyncGenerationTable.syncGenerationId, 'generation-a'));
      await tx.insert(SyncGenerationTable).values({
        projectId: 'project-a', projectSyncId: 'project-sync-a', syncGenerationId: 'generation-b',
        generationNumber: 2, status: 'active', createdAt: NOW, updatedAt: NOW,
      });
    });
    expect(await repo.prepareSource(firstGeneration.scope, firstGeneration.source)).toBeNull();
    expect(await repo.replaceSource(firstGeneration)).toBe(false);
    expect(await repo.pruneOrphanSources(firstGeneration.scope)).toBeNull();
    expect((await db.select().from(SyncGenerationTable))).toHaveLength(2);
  });

  it('rejects results belonging to a different database or repository owner', async () => {
    const first = await fixture();
    const second = await fixture();
    const prepared = await prepare(first.repo);
    expect(await second.repo.prepareSource(prepared.scope, prepared.source)).toBeNull();
    expect(await second.repo.replaceSource(prepared)).toBe(false);
    expect(await second.repo.pruneOrphanSources(prepared.scope)).toBeNull();
    expect(await mentions(second.db)).toEqual([]);
  });

  it('rejects revoked work even if it was queued before the transaction began', async () => {
    const { db, repo, revoke } = await fixture();
    const prepared = await prepare(repo);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const preceding = db.transaction(async () => { entered(); await barrier; });
    await ready;
    const pending = repo.replaceSource(prepared);
    revoke();
    const rejected = expect(pending).rejects.toBeInstanceOf(ReferenceIndexOwnerInactiveError);
    release();
    await preceding;
    await rejected;
    await expect(repo.captureCatalog()).rejects.toBeInstanceOf(ReferenceIndexOwnerInactiveError);
    expect(await mentions(db)).toEqual([]);
  });

  it('rolls back replacement when its owner is revoked during the delete/insert transaction', async () => {
    const { db, repo, gateway, revoke } = await fixture();
    await repo.replaceSource(await prepare(repo));
    const old = await mentions(db);
    const next = await prepare(repo);
    const execute = gateway.execute.bind(gateway);
    vi.spyOn(gateway, 'execute').mockImplementation(async (sql, parameters, transactionId) => {
      const result = await execute(sql, parameters, transactionId);
      if (sql.startsWith('delete from "inline_mention"')) revoke();
      return result;
    });
    await expect(repo.replaceSource(next)).rejects.toBeInstanceOf(ReferenceIndexOwnerInactiveError);
    expect(await mentions(db)).toEqual(old);
  });

  it('rolls back the deletion if replacement insertion fails and permits retry', async () => {
    const { db, repo, gateway } = await fixture();
    await repo.replaceSource(await prepare(repo));
    const old = await mentions(db);
    await db.update(NodeContentTable).set({ contentJson: json('replacement-target') });
    const next = await prepare(repo);
    gateway.failNextExecute((sql) => sql.startsWith('insert into "inline_mention"'));
    await expect(repo.replaceSource(next)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'injected acceptance execute failure' }) });
    expect(await mentions(db)).toEqual(old);
    expect(await repo.replaceSource(next)).toBe(true);
    expect((await mentions(db))[0]!.toId).toBe('replacement-target');
  });

  it('does not acknowledge a replacement whose commit fails', async () => {
    const { db, repo, gateway } = await fixture();
    await repo.replaceSource(await prepare(repo));
    const old = await mentions(db);
    const next = await prepare(repo);
    vi.spyOn(gateway, 'commit').mockRejectedValueOnce(new Error('commit failed'));
    await expect(repo.replaceSource(next)).rejects.toThrow('commit failed');
    expect(await mentions(db)).toEqual(old);
  });

  it('does not resurrect hard-deleted sources and prunes their old references', async () => {
    const { db, repo } = await fixture();
    const old = await prepare(repo);
    await repo.replaceSource(old);
    await db.delete(BookNodeTable).where(eq(BookNodeTable.id, 'node'));
    expect(await repo.replaceSource(old)).toBe(false);
    expect(await repo.pruneOrphanSources(old.scope)).toBe(1);
    expect(await mentions(db)).toEqual([]);
  });

  it('excludes trashed sources and child patches, then reprojects after restore', async () => {
    const { db, repo } = await fixture();
    const old = await replaceAll(repo);
    const patch = await prepare(repo, 'patch');
    for (const table of [BookNodeTable, BookElementTable, ElementCategoryTable, StorylineTable]) {
      await db.update(table).set({ deletedAt: NOW });
    }
    expect((await repo.captureCatalog())!.sources).toEqual([]);
    expect(await repo.replaceSource(patch)).toBe(false);
    expect(await repo.pruneOrphanSources(old.scope)).toBe(5);
    expect(await mentions(db)).toEqual([]);
    for (const table of [BookNodeTable, BookElementTable, ElementCategoryTable, StorylineTable]) {
      await db.update(table).set({ deletedAt: null });
    }
    await replaceAll(repo);
    expect(await mentions(db)).toHaveLength(5);
  });

  it('rechecks current existence so an old catalog cannot prune newly created sources', async () => {
    const { db, repo } = await fixture();
    const old = (await repo.captureCatalog())!;
    await seedSources(db, 'project-a', '-new');
    await replaceAll(repo);
    expect(await repo.pruneOrphanSources(old.scope)).toBe(0);
    expect(await mentions(db)).toHaveLength(10);
  });

  it('keeps writes within the owning project and preserves unsupported source formats', async () => {
    const { db, repo } = await fixture();
    await seedProject(db, 'project-b');
    const prepared = await prepare(repo);
    const other = createInlineMentionRepository(db);
    await other.replaceMentionsFromSource('project-b', 'node', 'node', [...prepared.drafts]);
    await other.replaceMentionsFromSource('project-a', 'comment', 'absent-comment', [...prepared.drafts]);
    const old = await mentions(db);
    expect(await repo.replaceSource(prepared)).toBe(true);
    expect(await repo.pruneOrphanSources(prepared.scope)).toBe(0);
    const current = await mentions(db);
    for (const row of old) expect(current).toContainEqual(row);
    expect(current).toHaveLength(3);
  });

  it('rejects changed source incarnations and sources moved to another project', async () => {
    const { db, repo } = await fixture();
    const old = await prepare(repo);
    await db.update(BookNodeTable).set({ createdAt: 'different-incarnation' });
    expect(await repo.replaceSource(old)).toBe(false);
    const current = await prepare(repo);
    await seedProject(db, 'project-b');
    await db.update(BookNodeTable).set({ projectId: 'project-b' });
    expect(await repo.replaceSource(current)).toBe(false);
    expect(await mentions(db)).toEqual([]);
  });

  it('captures source rows and Yjs versions in one consistent SQLite transaction', async () => {
    const { db, repo, gateway } = await fixture();
    const query = gateway.query.bind(gateway);
    let queuedWrite: Promise<void> | undefined;
    vi.spyOn(gateway, 'query').mockImplementation(async (sql, parameters, transactionId) => {
      const result = await query(sql, parameters, transactionId);
      if (sql.includes('from "book_node"') && !queuedWrite) {
        queuedWrite = db.transaction(async (tx) => {
          await tx.update(NodeContentTable).set({ contentJson: json('new-cache') });
          await createYjsRepository(tx).appendUpdate('node-content:node', Y.encodeStateAsUpdate(ydoc().doc));
        });
      }
      return result;
    });
    const captured = (await repo.captureCatalog())!;
    await queuedWrite;
    const source = captured.sources.find((item) => item.kind === 'node')!;
    expect(source.basis).toEqual({ kind: 'json', contentJson: json() });
    expect(await repo.prepareSource(captured.scope, source)).toBeNull();
    expect((await prepare(repo)).drafts[0]!.toId).toBe('durable-target');
  });

  it('clears an empty committed source without changing its prose', async () => {
    const { db, repo } = await fixture();
    await repo.replaceSource(await prepare(repo));
    await db.update(NodeContentTable).set({ contentJson: '{}' });
    const empty = await prepare(repo);
    expect(empty.drafts).toEqual([]);
    expect(await repo.replaceSource(empty)).toBe(true);
    expect(await mentions(db)).toEqual([]);
    expect((await db.select().from(NodeContentTable))[0]!.contentJson).toBe('{}');
  });

  it('rejects deleted and recreated project scopes even if entity IDs are reused', async () => {
    const { db, repo } = await fixture();
    const old: PreparedReferenceSource = await prepare(repo);
    await db.delete(ProjectTable).where(eq(ProjectTable.id, 'project-a'));
    expect(await repo.captureCatalog()).toBeNull();
    expect(await repo.replaceSource(old)).toBe(false);
    await seedProject(db, 'project-a');
    await db.update(ProjectTable).set({ createdAt: 'new-project-incarnation' });
    await seedSources(db, 'project-a');
    expect(await repo.replaceSource(old)).toBe(false);
  });
});
