import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { installHeadlessDatabaseClient } from '../lib/db';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../lib/agent/runtime/yjs-prose-command';
import { registerLiveYDoc } from '../lib/yjs-doc-registry';
import { BookNodeTable, NodeContentTable, ProjectTable, YjsDocumentRevisionTable, yjsSnapshots, yjsUpdates } from '../schema/drizzle';
import * as yjsRepo from '../sqlite-repo/yjs-repo';
import * as durability from './yjs-local-durability.service';
import { deriveCanonicalNodeProseProjection, reconcileProjectProseMetrics } from './node-prose-metrics.service';

const NOW = '2026-09-30T00:00:00.000Z';
const PROJECT = 'synthetic-metrics';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(count = 1, durable = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-prose-metrics-'));
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  const db = gateway.client();
  cleanups.push(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  cleanups.push(installHeadlessDatabaseClient(db, 'synthetic-metrics.db'));
  const contentJson = JSON.stringify({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, id: 'synthetic-heading' }, content: [{ type: 'text', text: '合成标题' }] },
    { type: 'paragraph', attrs: { id: 'synthetic-paragraph' }, content: [
      { type: 'text', text: '海风 hello 👩🏽‍🚀 e\u0301', marks: [{ type: 'bold' }, { type: 'italic' }] },
    ] },
  ] });
  const seed = await createYjsProseSeedState(contentJson);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, seed);
  cleanups.push(() => doc.destroy());
  const text = (doc.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText;
  const updates: Uint8Array[] = [];
  doc.on('update', update => updates.push(update));
  text.insert(text.length, ' 追加一');
  text.insert(text.length, ' 追加二');
  await db.insert(ProjectTable).values({ id: PROJECT, name: 'Synthetic', userId: 'synthetic', createdAt: NOW, updatedAt: NOW });
  for (let i = 0; i < count; i++) {
    const id = `node-${i}`;
    await db.insert(BookNodeTable).values({ id, projectId: PROJECT, title: 'Synthetic', bookOrder: i,
      kind: i % 2 ? 'drift' : 'chapter', positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW });
    await db.insert(NodeContentTable).values({ nodeId: id, contentJson, outlineJson: '[]', createdAt: NOW, updatedAt: NOW });
    if (durable) {
      await db.insert(yjsSnapshots).values({ docId: `node-content:${id}`, stateBlob: seed, updatedAt: NOW });
      for (const [j, updateBlob] of updates.entries()) await db.insert(yjsUpdates).values({ id: i * 10 + j * 2 + 1,
        docId: `node-content:${id}`, updateBlob, createdAt: NOW });
      await db.insert(YjsDocumentRevisionTable).values({ docId: `node-content:${id}`, revision: 3, updatedAt: NOW });
    }
  }
  const rows = () => gateway.database.prepare(`SELECT n.id,n.word_count,n.word_count_basis_kind,n.word_count_basis_hash,
    n.word_count_basis_revision,n.updated_at,c.content_json,c.outline_json,c.updated_at AS content_updated_at
    FROM book_node n JOIN node_content c ON c.node_id=n.id ORDER BY n.id`).all();
  return { db, gateway, doc, text, rows };
}

function registerSession(db: Awaited<ReturnType<typeof fixture>>['db'], doc: Y.Doc) {
  cleanups.push(registerLiveYDoc('node-content:node-0', doc));
  let flushed = false;
  const unregister = durability.registerLocalYjsDocument(PROJECT, 'node-content:node-0', async () => {
    if (flushed) return;
    await db.transaction(tx => yjsRepo.createYjsRepository(tx).appendUpdate('node-content:node-0', Y.encodeStateAsUpdate(doc)));
    flushed = true;
  });
  cleanups.push(async () => { unregister(); await durability.waitForYjsDocumentTeardown(); });
}

const reconcile = () => reconcileProjectProseMetrics(PROJECT, { publishToDataStore: false });
async function expected(doc: Y.Doc, revision: number) {
  return deriveCanonicalNodeProseProjection('node-0', { docId: 'node-content:node-0', sourceKind: 'closed', revision,
    stateUpdate: Y.encodeStateAsUpdate(doc), stateHash: '', stateVector: new Uint8Array() });
}

describe('bounded prose metrics with product SQLite', () => {
  it('keeps exact formatting, outline, hash and revision across bounded groups; repeat does not write', async () => {
    const { gateway, doc, rows } = await fixture(18);
    const read = vi.spyOn(yjsRepo, 'readPersistedYjsDocuments');
    const projection = await expected(doc, 3);
    const authoritative = () => ['yjs_snapshots', 'yjs_updates', 'yjs_document_revision', 'sync_change_set']
      .map(table => gateway.database.prepare(`SELECT * FROM ${table}`).all());
    const before = authoritative();
    await reconcile();
    expect(read.mock.calls.map(([, ids]) => ids.length)).toEqual([16, 2]);
    for (const row of rows()) expect(row).toMatchObject({ word_count: projection.wordCount,
      word_count_basis_kind: 'yjs', word_count_basis_hash: projection.wordCountBasisHash, word_count_basis_revision: 3,
      content_json: projection.contentJson, outline_json: projection.outlineJson, updated_at: NOW, content_updated_at: NOW });
    expect(authoritative()).toEqual(before);
    const changes = () => gateway.database.prepare('SELECT total_changes() AS n').get()!.n;
    const firstChanges = changes();
    await reconcile();
    expect(changes()).toEqual(firstChanges);
  });

  it('retains seed-only materialization and rejects corrupt nonzero empty revisions', async () => {
    const { db, rows } = await fixture(1, false);
    await reconcile();
    expect(rows()[0]).toMatchObject({ word_count_basis_kind: 'seed', word_count_basis_revision: null });
    await db.insert(YjsDocumentRevisionTable).values({ docId: 'node-content:node-0', revision: 4, updatedAt: NOW });
    await expect(reconcile()).rejects.toMatchObject({ code: 'CORRUPT_EMPTY_STATE' });
  });

  it('uses the live capture/flush lifecycle instead of a persisted snapshot', async () => {
    const { db, doc, text, rows } = await fixture();
    text.insert(text.length, ' live 编辑未落盘');
    const projection = await expected(doc, 4);
    registerSession(db, doc);
    const flush = vi.spyOn(durability, 'flushOpenYjsDocument');
    const read = vi.spyOn(yjsRepo, 'readPersistedYjsDocuments');
    await reconcile();
    expect(read).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(rows()[0]).toMatchObject({ content_json: projection.contentJson, word_count: projection.wordCount });
  });

  it.each([false, true])('recaptures changed revision after batch read (cached projection: %s)', async (cached) => {
    const { db, doc, text, rows } = await fixture();
    if (cached) await reconcile();
    const original = yjsRepo.readPersistedYjsDocuments;
    vi.spyOn(yjsRepo, 'readPersistedYjsDocuments').mockImplementationOnce(async (tx, ids) => {
      const captured = await original(tx, ids);
      let update!: Uint8Array;
      doc.once('update', value => { update = value; });
      text.insert(text.length, ' 并发追加');
      await tx.insert(yjsUpdates).values({ docId: 'node-content:node-0', updateBlob: update, createdAt: NOW });
      await tx.update(YjsDocumentRevisionTable).set({ revision: 4 }).where(eq(YjsDocumentRevisionTable.docId, 'node-content:node-0'));
      return captured;
    });
    await reconcile();
    expect(rows()[0]).toMatchObject({ content_json: (await expected(doc, 4)).contentJson, word_count_basis_revision: 4 });
    expect((await db.select().from(YjsDocumentRevisionTable))[0].revision).toBe(4);
  });

  it('switches to a live document that opens after the batched read', async () => {
    const { db, doc, text, rows } = await fixture();
    const original = yjsRepo.readPersistedYjsDocuments;
    vi.spyOn(yjsRepo, 'readPersistedYjsDocuments').mockImplementationOnce(async (tx, ids) => {
      const captured = await original(tx, ids);
      text.insert(text.length, ' 刚打开的编辑');
      registerSession(db, doc);
      return captured;
    });
    await reconcile();
    expect(rows()[0]).toMatchObject({ content_json: (await expected(doc, 4)).contentJson, word_count_basis_revision: 4 });
  });
});
