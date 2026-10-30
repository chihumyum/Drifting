import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { renderWorkspaceProseFile } from '../../lib/agent/runtime/workspace-prose-file';
import {
  replaceYjsProseBlocks,
  snapshotYjsProseBlocks,
} from '../../lib/agent/runtime/yjs-prose-command';
import type { DbClient } from '../../lib/db';
import { proseDocId } from '../../lib/yjs-doc-id';
import type { MarkdownProjectionReadRequest, MarkdownProjectionWriteResult } from '../../platform/contracts';
import { BookNodeTable, NodeContentTable, ProjectTable } from '../../schema/drizzle';
import { createMarkdownMirrorRepository } from '../../sqlite-repo/markdown-mirror-repo';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import type { LocalRelationalMarkdownSource } from '../export/relational-markdown.local-source';
import { createMarkdownMirror } from './mirror';

const disk = vi.hoisted(() => new Map<string, { text: string; modifiedMs: number }>());
const databaseSlot = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return { ...actual, getDb: () => databaseSlot.current as ReturnType<typeof actual.getDb> };
});
vi.mock('../../lib/agent/chapter-prose', () => ({ relinkBlockMentions: () => undefined }));
vi.mock('../../sync/journal/installation-identity', () => ({
  getSyncInstallationIdentity: async () => ({
    installationId: 'synthetic-mirror-install',
    createWriterIdentity: () => ({ writerId: 'synthetic-mirror-writer', writerEpoch: 'synthetic-mirror-epoch' }),
  }),
}));
vi.mock('../../platform', () => ({
  platform: {
    markdownProjection: {
      // The native reader over an in-memory folder.
      read: async (_projectId: string, requests: MarkdownProjectionReadRequest[]) =>
        requests.map((request) => {
          const file = disk.get(request.path);
          if (!file) {
            return { path: request.path, exists: false, size: 0, modifiedMs: 0, changed: request.knownSize !== null, sha256: null, text: null, error: null };
          }
          const size = Buffer.byteLength(file.text);
          const changed = Boolean(request.force) || request.knownSize !== size || request.knownModifiedMs !== file.modifiedMs;
          return {
            path: request.path, exists: true, size, modifiedMs: file.modifiedMs, changed,
            sha256: changed ? createHash('sha256').update(file.text).digest('hex') : null,
            text: changed ? file.text : null,
            error: null,
          };
        }),
    },
  },
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
  disk.clear();
  databaseSlot.current = null;
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-markdown-mirror-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  databaseSlot.current = db;
  await db.insert(ProjectTable).values({ id: PROJECT_ID, userId: 'local-user', name: 'Mirror', createdAt: NOW, updatedAt: NOW });
  await db.insert(BookNodeTable).values({
    id: NODE_ID, title: '雨夜', summary: '', projectId: PROJECT_ID, kind: 'chapter', writingStatus: 'draft',
    positionX: 0, positionY: 0, createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(NodeContentTable).values({ nodeId: NODE_ID, contentJson: '{}', createdAt: NOW, updatedAt: NOW });
  const doc = new Y.Doc({ gc: false });
  replaceYjsProseBlocks(doc, [{ id: 'p1', type: 'paragraph', content: [{ kind: 'text', text: '林岚推开门。' }] }]);
  await createYjsRepository(db).appendUpdate(DOC_ID, Y.encodeStateAsUpdate(doc));
  return db;
}

async function source(db: DbClient): Promise<LocalRelationalMarkdownSource> {
  const nodes = await db.select().from(BookNodeTable);
  const nodeContents = await db.select().from(NodeContentTable);
  return { books: [{ project: { id: PROJECT_ID }, graph: { nodes, nodeContents } }], proseByDocId: new Map() } as never;
}

const documents = [{ key: `node:${NODE_ID}`, path: FILE_PATH, title: '雨夜', anchor: null, sourceVersion: null }];
const result = (conflicts: string[] = []): MarkdownProjectionWriteResult => ({
  directory: DIRECTORY, customRoot: null, generatedAt: NOW, readOnly: false, reverseSync: true, conflicts, preserved: [],
});

/** The native writer: replace only bytes the ledger expects. */
function write(entries: { path: string; text: string; expectedSha256?: string | null }[]): string[] {
  const conflicts: string[] = [];
  for (const entry of entries) {
    const current = disk.get(entry.path);
    const hash = current && createHash('sha256').update(current.text).digest('hex');
    if (current && entry.expectedSha256 && hash !== entry.expectedSha256 && current.text !== entry.text) {
      conflicts.push(entry.path);
      continue;
    }
    disk.set(entry.path, { text: entry.text, modifiedMs: Date.now() - 10_000 });
  }
  return conflicts;
}

function editOnDisk(change: (text: string) => string) {
  const file = disk.get(FILE_PATH)!;
  disk.set(FILE_PATH, { text: change(file.text), modifiedMs: file.modifiedMs + 1 });
}

async function prose(db: DbClient): Promise<string> {
  const doc = new Y.Doc({ gc: false });
  const repo = createYjsRepository(db);
  const snapshot = await repo.getSnapshot(DOC_ID);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob);
  for (const update of await repo.listUpdates(DOC_ID)) Y.applyUpdate(doc, update.updateBlob);
  return renderWorkspaceProseFile(snapshotYjsProseBlocks(doc));
}

async function typeInDrifting(db: DbClient, text: string) {
  const repo = createYjsRepository(db);
  const doc = new Y.Doc({ gc: false });
  const snapshot = await repo.getSnapshot(DOC_ID);
  if (snapshot) Y.applyUpdate(doc, snapshot.stateBlob);
  for (const update of await repo.listUpdates(DOC_ID)) Y.applyUpdate(doc, update.updateBlob);
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const element = doc.getXmlFragment('default').get(0) as Y.XmlElement;
  const yText = element.get(0) as Y.XmlText;
  yText.insert(yText.length, text);
  for (const update of updates) await repo.appendUpdate(DOC_ID, update);
}

async function capture(db: DbClient, mirror = createMarkdownMirror(PROJECT_ID), conflictsBeforeWrite?: () => void) {
  await mirror.scan(DIRECTORY);
  const prepared = await mirror.prepare(await source(db), documents, DIRECTORY);
  conflictsBeforeWrite?.();
  const conflicts = write(prepared.entries);
  await mirror.settle(prepared.renders, DIRECTORY, result(conflicts));
  return { prepared, conflicts };
}

describe('Markdown folder ledger', () => {
  it('writes, reads back an external edit, and writes the merge without re-reading itself', async () => {
    const db = await setup();
    const mirror = createMarkdownMirror(PROJECT_ID);
    const first = await capture(db, mirror);
    expect(first.prepared.entries[0]).toMatchObject({ authored: true, expectedSha256: null });
    expect(disk.get(FILE_PATH)!.text).toContain('drifting-id: chapter-1\n');
    expect(disk.get(FILE_PATH)!.text.endsWith('\n林岚推开门。\n')).toBe(true);
    const row = (await createMarkdownMirrorRepository().get(PROJECT_ID, DOC_ID))!;
    expect(row).toMatchObject({ path: FILE_PATH, pending: null });
    expect(row.fileSha256).toBe(createHash('sha256').update(disk.get(FILE_PATH)!.text).digest('hex'));

    // Drifting's own file is not an edit.
    expect(await mirror.scan(DIRECTORY, { force: true })).toEqual({ merged: 0, issues: [] });

    editOnDisk((text) => text.replace('林岚推开门。', '林岚轻轻推开门。\n雨很大。'));
    expect(await mirror.scan(DIRECTORY)).toEqual({ merged: 1, issues: [] });
    expect(await prose(db)).toBe('林岚轻轻推开门。\n\n雨很大。');

    // The file already says this: the next capture leaves it alone.
    const before = disk.get(FILE_PATH)!;
    const next = await capture(db, mirror);
    expect(next.prepared.entries[0]!.expectedSha256).toBe(createHash('sha256').update(before.text).digest('hex'));
    expect(disk.get(FILE_PATH)!.text).toContain('林岚轻轻推开门。\n\n雨很大。');
  });

  it('confirms a write that reached disk before a crash instead of merging it again', async () => {
    const db = await setup();
    await capture(db);
    await typeInDrifting(db, '雨很大。');
    const mirror = createMarkdownMirror(PROJECT_ID);
    const prepared = await mirror.prepare(await source(db), documents, DIRECTORY);
    write(prepared.entries);
    // The app quits before `settle`. A fresh session reads its own bytes.
    const restarted = createMarkdownMirror(PROJECT_ID);
    expect(await restarted.scan(DIRECTORY, { force: true })).toEqual({ merged: 0, issues: [] });
    expect(await prose(db)).toBe('林岚推开门。雨很大。');
    const row = (await createMarkdownMirrorRepository().get(PROJECT_ID, DOC_ID))!;
    expect(row.pending).toBeNull();
    expect(row.fileSha256).toBe(createHash('sha256').update(disk.get(FILE_PATH)!.text).digest('hex'));
  });

  it('reports an edit it cannot merge and rewrites the file instead of blocking it', async () => {
    const db = await setup();
    const mirror = createMarkdownMirror(PROJECT_ID);
    await capture(db, mirror);
    editOnDisk((text) => text.replace('林岚推开门。', ''));
    expect(await mirror.scan(DIRECTORY)).toEqual({ merged: 0, issues: [{ path: FILE_PATH, reason: 'empty' }] });
    // The next write keeps the emptied file aside (native) and restores it.
    const next = await capture(db, mirror);
    expect(next.prepared.entries[0]!.expectedSha256).toBeNull();
    expect(disk.get(FILE_PATH)!.text.endsWith('\n林岚推开门。\n')).toBe(true);
    expect(await prose(db)).toBe('林岚推开门。');

    // A malformed header waits: it is neither merged nor overwritten.
    editOnDisk((text) => text.replace('摘要: ""', '摘要: "未闭合'));
    const broken = disk.get(FILE_PATH)!.text;
    await typeInDrifting(db, '雨很大。');
    const blocked = await capture(db, mirror);
    expect(blocked.conflicts).toEqual([FILE_PATH]);
    expect(disk.get(FILE_PATH)!.text).toBe(broken);
    expect((await mirror.scan(DIRECTORY)).issues).toEqual([{ path: FILE_PATH, reason: 'frontmatter' }]);
    editOnDisk((text) => text.replace('摘要: "未闭合', '摘要: ""'));
    await capture(db, mirror);
    expect(disk.get(FILE_PATH)!.text.endsWith('\n林岚推开门。雨很大。\n')).toBe(true);
    expect((await mirror.scan(DIRECTORY)).issues).toEqual([]);
  });

  it('leaves a file edited during a write for the next scan and keeps both edits', async () => {
    const db = await setup();
    await capture(db);
    await typeInDrifting(db, '雨很大。');
    const mirror = createMarkdownMirror(PROJECT_ID);
    const { conflicts } = await capture(db, mirror, () => editOnDisk((text) => text.replace('林岚推开门', '林岚轻轻推开门')));
    expect(conflicts).toEqual([FILE_PATH]);
    expect((await createMarkdownMirrorRepository().get(PROJECT_ID, DOC_ID))!.pending).toBeNull();
    expect(disk.get(FILE_PATH)!.text).toContain('林岚轻轻推开门。\n');

    await capture(db, mirror);
    expect(await prose(db)).toBe('林岚轻轻推开门。雨很大。');
    expect(disk.get(FILE_PATH)!.text).toContain('\n林岚轻轻推开门。雨很大。\n');
    const [node] = await db.select().from(BookNodeTable).where(eq(BookNodeTable.id, NODE_ID));
    expect(node!.wordCountBasisKind).toBe('yjs');
  });
});
