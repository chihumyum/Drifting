import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  replaceYjsProseBlocks,
  snapshotYjsProseBlocks,
  type YjsProseBlock,
} from '../../lib/agent/runtime/yjs-prose-command';
import { renderWorkspaceProseFile } from '../../lib/agent/runtime/workspace-prose-file';
import type { DbClient } from '../../lib/db';
import { proseDocId } from '../../lib/yjs-doc-id';
import {
  BookNodeTable,
  NodeContentTable,
  ProjectTable,
  YjsDocumentRevisionProvenanceTable,
} from '../../schema/drizzle';
import { createMarkdownMirrorRepository } from '../../sqlite-repo/markdown-mirror-repo';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { renderAuthoredFile } from './authored-file';
import { ingestAuthoredFile } from './ingest';
import { useAgentEditStore } from '../../store/agent-edit-store';

const databaseSlot = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return { ...actual, getDb: () => databaseSlot.current as ReturnType<typeof actual.getDb> };
});
// Synthetic peers have no registered entities to auto-link.
vi.mock('../../lib/agent/chapter-prose', () => ({ relinkBlockMentions: () => undefined }));
vi.mock('../../sync/journal/installation-identity', () => ({
  getSyncInstallationIdentity: async () => ({
    installationId: 'synthetic-mirror-install',
    createWriterIdentity: () => ({ writerId: 'synthetic-mirror-writer', writerEpoch: 'synthetic-mirror-epoch' }),
  }),
}));

const PROJECT_ID = 'project-mirror';
const NODE_ID = 'chapter-1';
const DOC_ID = proseDocId('node', NODE_ID);
const DIRECTORY = '/synthetic/markdown-projections/project-mirror';
const FILE_PATH = '正文/001 雨夜.md';
const NOW = '2026-10-31T00:00:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  databaseSlot.current = null;
  useAgentEditStore.getState().clearAll();
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const paragraph = (id: string, text: string): YjsProseBlock => ({
  id,
  type: 'paragraph',
  content: [{ kind: 'text', text }],
});

async function setup(blocks: YjsProseBlock[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-markdown-mirror-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  databaseSlot.current = db;
  await db.insert(ProjectTable).values({ id: PROJECT_ID, userId: 'local-user', name: 'Mirror', createdAt: NOW, updatedAt: NOW });
  await db.insert(BookNodeTable).values({
    id: NODE_ID, title: '雨夜', summary: '旧摘要', projectId: PROJECT_ID, kind: 'chapter', writingStatus: 'draft',
    positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(NodeContentTable).values({ nodeId: NODE_ID, contentJson: '{}', createdAt: NOW, updatedAt: NOW });
  const base = new Y.Doc({ gc: false });
  replaceYjsProseBlocks(base, blocks);
  const baseState = Y.encodeStateAsUpdate(base);
  await createYjsRepository(db).appendUpdate(DOC_ID, baseState);
  await createMarkdownMirrorRepository(db).record(PROJECT_ID, DOC_ID, DIRECTORY, {
    path: FILE_PATH,
    fileSha256: 'a'.repeat(64),
    baseState,
    baseFieldsJson: JSON.stringify({ status: 'draft', summary: '旧摘要', extra: '' }),
  });
  return { db, base };
}

/** Drifting edits the stored document after the file was written. */
async function driftingEdit(db: DbClient, edit: (doc: Y.Doc) => void) {
  const repo = createYjsRepository(db);
  const doc = new Y.Doc({ gc: false });
  for (const update of await repo.listUpdates(DOC_ID)) Y.applyUpdate(doc, update.updateBlob);
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  edit(doc);
  for (const update of updates) await repo.appendUpdate(DOC_ID, update);
}

async function stored(db: DbClient): Promise<YjsProseBlock[]> {
  const repo = createYjsRepository(db);
  const doc = new Y.Doc({ gc: false });
  const snapshot = await repo.getSnapshot(DOC_ID);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob);
  for (const update of await repo.listUpdates(DOC_ID)) Y.applyUpdate(doc, update.updateBlob);
  return snapshotYjsProseBlocks(doc);
}

const file = (body: string, status: 'draft' | 'finished' = 'draft', summary = '旧摘要') =>
  renderAuthoredFile({ id: NODE_ID, title: '雨夜', fields: { status, summary }, extra: '', body });

async function ingest(text: string, sha256 = 'b'.repeat(64)) {
  const row = (await createMarkdownMirrorRepository().get(PROJECT_ID, DOC_ID))!;
  return ingestAuthoredFile({ projectId: PROJECT_ID, nodeId: NODE_ID, row, text, sha256 });
}

describe('merging an edited Markdown file into Drifting', () => {
  it('merges prose and fields with concurrent Drifting edits in one transaction', async () => {
    const { db } = await setup([paragraph('p1', '林岚推开门。雨很大。'), paragraph('p2', '屋里很暗。')]);
    await driftingEdit(db, (doc) => {
      const element = doc.getXmlFragment('default').get(0) as Y.XmlElement;
      (element.get(0) as Y.XmlText).insert(2, '缓缓');
    });

    const result = await ingest(file('林岚推开门。雨下得很大。\n\n屋里很暗。', 'finished', '新的摘要'));

    // Different spots of one paragraph merge cleanly and need no attention.
    expect(result).toMatchObject({ kind: 'merged', overlapped: [], restored: [] });
    // Drifting shows what the file changed in its current prose, in blue.
    expect(result.kind === 'merged' && result.changes.map((change) => [change.blockId, change.op, change.newText])).toEqual([
      ['p1', 'changed', '林岚缓缓推开门。雨下得很大。'],
    ]);
    const pending = useAgentEditStore.getState().pending[`node:${NODE_ID}`]!;
    expect(pending.lastSource).toBe('file');
    expect(pending.changes.map((change) => [change.blockId, change.source])).toEqual([['p1', 'file']]);
    expect(renderWorkspaceProseFile(await stored(db))).toBe('林岚缓缓推开门。雨下得很大。\n\n屋里很暗。');
    const [node] = await db.select().from(BookNodeTable).where(eq(BookNodeTable.id, NODE_ID));
    expect(node).toMatchObject({ writingStatus: 'finished', summary: '新的摘要', wordCountBasisKind: 'yjs' });
    const [content] = await db.select().from(NodeContentTable).where(eq(NodeContentTable.nodeId, NODE_ID));
    expect(content!.contentJson).toContain('雨下得很大');
    const provenance = await db.select().from(YjsDocumentRevisionProvenanceTable);
    expect(provenance.map((row) => row.sourceKind)).toContain('file');

    const row = (await createMarkdownMirrorRepository().get(PROJECT_ID, DOC_ID))!;
    expect(row.fileSha256).toBe('b'.repeat(64));
    expect(JSON.parse(row.baseFieldsJson)).toMatchObject({ status: 'finished', summary: '新的摘要' });
    // The new base is what the file says: Drifting's own edit is not in it.
    const base = new Y.Doc({ gc: false });
    Y.applyUpdate(base, row.baseState);
    expect(renderWorkspaceProseFile(snapshotYjsProseBlocks(base))).toBe('林岚推开门。雨下得很大。\n\n屋里很暗。');
  });

  it('reports a paragraph both sides changed at the same spot with its merged text', async () => {
    const { db } = await setup([paragraph('p1', '他笑了。'), paragraph('p2', '屋里很暗。')]);
    await driftingEdit(db, (doc) => {
      const element = doc.getXmlFragment('default').get(0) as Y.XmlElement;
      (element.get(0) as Y.XmlText).insert(1, '苦');
    });
    const result = await ingest(file('他哭了。\n\n屋里很暗。'));
    expect(result.kind).toBe('merged');
    const merged = renderWorkspaceProseFile(await stored(db)).split('\n\n')[0]!;
    expect(['他苦哭了。', '他哭苦了。']).toContain(merged);
    expect(result).toMatchObject({ overlapped: [{ blockId: 'p1', text: merged }] });
  });

  it('reads the same bytes twice without applying them twice', async () => {
    const { db } = await setup([paragraph('p1', '林岚推开门。')]);
    const edited = file('林岚轻轻推开门。');
    expect((await ingest(edited)).kind).toBe('merged');
    expect(await ingest(edited)).toEqual({ kind: 'unchanged' });
    expect(renderWorkspaceProseFile(await stored(db))).toBe('林岚轻轻推开门。');
  });

  it('puts back a paragraph the file edited after Drifting deleted it', async () => {
    const { db } = await setup([paragraph('p1', '第一段。'), paragraph('p2', '窗外的雨停了。'), paragraph('p3', '第三段。')]);
    await driftingEdit(db, (doc) => doc.getXmlFragment('default').delete(1, 1));

    const result = await ingest(file('第一段。\n\n窗外的雨停了，鸟开始叫。\n\n第三段。'));

    expect(result).toMatchObject({ kind: 'merged', restored: ['p2'] });
    expect(renderWorkspaceProseFile(await stored(db))).toBe('第一段。\n\n窗外的雨停了，鸟开始叫。\n\n第三段。');
  });

  it('refuses a base from another history and an emptied file', async () => {
    const { db } = await setup([paragraph('p1', '林岚推开门。')]);
    const stranger = new Y.Doc({ gc: false });
    replaceYjsProseBlocks(stranger, [paragraph('p1', '林岚推开门。')]);
    const repo = createMarkdownMirrorRepository();
    const row = (await repo.get(PROJECT_ID, DOC_ID))!;
    await repo.record(PROJECT_ID, DOC_ID, DIRECTORY, { ...row, baseState: Y.encodeStateAsUpdate(stranger) });

    expect(await ingest(file('林岚轻轻推开门。'))).toEqual({ kind: 'skipped', reason: 'lineage' });
    expect(await ingest(file(''))).toEqual({ kind: 'skipped', reason: 'empty' });
    expect(await ingest('---\n摘要: "坏的\n---\n正文')).toEqual({ kind: 'skipped', reason: 'frontmatter' });
    expect(await ingest(renderAuthoredFile({ id: 'other', title: 'x', fields: { status: 'draft', summary: '' }, extra: '', body: '别处' })))
      .toEqual({ kind: 'skipped', reason: 'identity' });
    expect(renderWorkspaceProseFile(await stored(db))).toBe('林岚推开门。');
  });
});
