import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductFileBackedSqliteGateway } from '../../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import { createYjsProseSeedState } from '../../lib/agent/runtime/yjs-prose-command';
import { proseDocId } from '../../lib/yjs-doc-id';
import type { DbClient } from '../../lib/db';
import { BookNodeTable, NodeContentTable, ProjectTable } from '../../schema/drizzle';
import { createYjsRepository } from '../../sqlite-repo/yjs-repo';
import { readLocalRelationalMarkdownSource } from './relational-markdown.local-source';

const databaseSlot = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return { ...actual, getDb: () => databaseSlot.current as ReturnType<typeof actual.getDb> };
});

const PROJECT_ID = 'project-incremental-capture';
const NOW = '2026-10-29T00:00:00.000Z';
const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  databaseSlot.current = null;
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const prose = (text: string) => createYjsProseSeedState(JSON.stringify({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
}));

async function database(): Promise<DbClient> {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-incremental-capture-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'drifting.db'));
  gateways.push(gateway);
  const db = gateway.client();
  databaseSlot.current = db;
  await db.insert(ProjectTable).values({ id: PROJECT_ID, userId: 'local-user', name: 'Capture', createdAt: NOW, updatedAt: NOW });
  for (const [id, deletedAt] of [['opened', null], ['edited', null], ['seed-only', null], ['trashed', NOW]] as const) {
    await db.insert(BookNodeTable).values({
      id, title: id, summary: '', projectId: PROJECT_ID, kind: 'chapter', writingStatus: 'draft',
      positionX: 0, positionY: 0, deletedAt, createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(NodeContentTable).values({ nodeId: id, contentJson: `{"seed":"${id}"}`, createdAt: NOW, updatedAt: NOW });
  }
  return db;
}

describe('incremental Markdown projection capture', () => {
  it('reads Yjs bytes and seeds only for documents whose persisted version moved', async () => {
    const db = await database();
    const repository = createYjsRepository(db);
    for (const id of ['opened', 'edited', 'trashed']) await repository.appendUpdate(proseDocId('node', id), await prose(id));

    const first = await readLocalRelationalMarkdownSource(PROJECT_ID, { knownProseVersions: new Map() });
    expect([...first.proseByDocId.keys()].sort()).toEqual([proseDocId('node', 'edited'), proseDocId('node', 'opened')]);
    expect([...first.proseVersions!.keys()].sort()).toEqual([proseDocId('node', 'edited'), proseDocId('node', 'opened')]);
    expect(first.books[0]!.graph.nodeContents.map(row => row.nodeId)).toEqual(['edited', 'opened', 'seed-only']);

    await repository.appendUpdate(proseDocId('node', 'edited'), await prose('edited again'));
    const next = await readLocalRelationalMarkdownSource(PROJECT_ID, { knownProseVersions: first.proseVersions });
    expect([...next.proseByDocId.keys()]).toEqual([proseDocId('node', 'edited')]);
    expect(next.proseByDocId.get(proseDocId('node', 'edited'))!.updates).toHaveLength(2);
    expect(next.proseVersions!.get(proseDocId('node', 'opened'))).toBe(first.proseVersions!.get(proseDocId('node', 'opened')));
    expect(next.proseVersions!.get(proseDocId('node', 'edited'))).not.toBe(first.proseVersions!.get(proseDocId('node', 'edited')));
    // A document without Yjs state keeps its seed, which is its prose.
    expect(next.books[0]!.graph.nodeContents.map(row => row.nodeId)).toEqual(['edited', 'seed-only']);
    expect(next.books[0]!.graph.nodes).toHaveLength(4);

    // Without known versions, a capture stays complete, as exports need.
    const complete = await readLocalRelationalMarkdownSource(PROJECT_ID);
    expect(complete.proseByDocId.size).toBe(3);
    expect(complete.proseVersions).toBeUndefined();
    expect(complete.books[0]!.graph.nodeContents).toHaveLength(4);
  });
});
