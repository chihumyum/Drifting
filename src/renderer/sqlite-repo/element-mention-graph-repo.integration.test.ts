import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BookElement } from '../domain/book-element';
import type { BookNode } from '../domain/book-node';
import { ProductFileBackedSqliteGateway } from '../lib/agent/runtime/acceptance/p3-file-backed-sqlite';
import {
  BookElementTable,
  BookNodeTable,
  InlineMentionTable,
  ProjectTable,
} from '../schema/drizzle';
import {
  buildElementMentionGraph,
  elementMentionPairKey,
  elementMentionScopeKey,
} from '../usecase/useElementMentionGraph';
import { readElementMentionGraphRows } from './element-mention-graph-repo';

// Every row below is synthetic: invented ids, names and spans.
const NOW = '2026-10-30T00:00:00.000Z';
const PROJECT = 'project-isles';
const OTHER = 'project-other';
const stamps = { createdAt: NOW, updatedAt: NOW };

const directories: string[] = [];
const gateways: ProductFileBackedSqliteGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'drifting-element-mention-graph-'));
  directories.push(directory);
  const gateway = new ProductFileBackedSqliteGateway(path.join(directory, 'synthetic.db'));
  gateways.push(gateway);
  const db = gateway.client();
  await db.insert(ProjectTable).values([
    { id: PROJECT, userId: 'synthetic-user', name: 'Isles', ...stamps },
    { id: OTHER, userId: 'synthetic-user', name: 'Other', ...stamps },
  ]);
  const node = (id: string, projectId: string, kind: 'chapter' | 'drift', deletedAt: string | null = null) => ({
    id, projectId, kind, title: id, deletedAt, positionX: 0, positionY: 0, ...stamps,
  });
  await db.insert(BookNodeTable).values([
    node('ch1', PROJECT, 'chapter'),
    node('ch2', PROJECT, 'chapter'),
    node('drift', PROJECT, 'drift'),
    node('ch-trashed', PROJECT, 'chapter', NOW),
    node('ch-other', OTHER, 'chapter'),
  ]);
  const element = (id: string, projectId: string, deletedAt: string | null = null) => ({
    id, projectId, name: id, deletedAt, ...stamps,
  });
  await db.insert(BookElementTable).values([
    element('alice', PROJECT),
    element('bob', PROJECT),
    element('carol', PROJECT),
    element('dave-trashed', PROJECT, NOW),
    element('eve', OTHER),
    element('frank', OTHER),
  ]);
  return { gateway, db };
}

let rowId = 0;
function spans(count: number): string {
  return JSON.stringify(Array.from({ length: count }, (_, i) => ({ from: i * 10, to: i * 10 + 3, text: 'syn' })));
}
function mention(
  fromId: string,
  fromBlockId: string,
  toId: string,
  fromSpansJson = spans(1),
  overrides: Partial<typeof InlineMentionTable.$inferInsert> = {},
): typeof InlineMentionTable.$inferInsert {
  rowId += 1;
  return {
    id: `mention-${rowId}`,
    projectId: PROJECT,
    fromKind: 'node',
    fromId,
    fromBlockId,
    fromSpansJson,
    toKind: 'element',
    toId,
    ...stamps,
    ...overrides,
  };
}

const SCENARIO = [
  // ch1 · p1: alice twice and bob once -> one alice|bob paragraph.
  mention('ch1', 'p1', 'alice', spans(2)),
  mention('ch1', 'p1', 'bob'),
  // ch1 · p2: three elements -> every pair once.
  mention('ch1', 'p2', 'alice'),
  mention('ch1', 'p2', 'bob'),
  mention('ch1', 'p2', 'carol'),
  // ch1 · p3: carol alone, three spans.
  mention('ch1', 'p3', 'carol', spans(3)),
  // ch1 · p4: a trashed element counts nowhere and pairs with nobody.
  mention('ch1', 'p4', 'alice'),
  mention('ch1', 'p4', 'dave-trashed'),
  // ch2 · p1 reuses ch1's block id: carol must not pair with ch1 · p1.
  mention('ch2', 'p1', 'carol'),
  // ch2 · q1: malformed and empty span lists still count once each.
  mention('ch2', 'q1', 'bob', 'not json'),
  mention('ch2', 'q1', 'carol', '[]'),
  // ch2 · q2: alice alone; ch2 · q3: alice and bob in different blocks only.
  mention('ch2', 'q2', 'alice'),
  mention('ch2', 'q3', 'bob', spans(1)),
  // Drift prose, trashed chapters, element bodies and non-element targets are out.
  mention('drift', 'x1', 'alice'),
  mention('drift', 'x1', 'bob'),
  mention('ch-trashed', 't1', 'alice'),
  mention('ch-trashed', 't1', 'bob'),
  mention('alice', 'e1', 'bob', spans(1), { fromKind: 'element' }),
  mention('ch1', 'p1', 'ch2', spans(1), { toKind: 'node' }),
  // Another project's prose, and a stray row pointing across projects.
  mention('ch-other', 'o1', 'eve', spans(1), { projectId: OTHER }),
  mention('ch-other', 'o1', 'frank', spans(1), { projectId: OTHER }),
  mention('ch1', 'p2', 'eve'),
];

function sortRows<T extends object>(rows: T[]): T[] {
  return [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

describe('element mention graph aggregate', () => {
  it('counts chapter-prose mentions per element and chapter, and paragraph co-occurrence per pair, in one statement', async () => {
    const { gateway, db } = await createDatabase();
    await db.insert(InlineMentionTable).values(SCENARIO);
    const query = vi.spyOn(gateway, 'query');

    const rows = await readElementMentionGraphRows(PROJECT, db);

    expect(query).toHaveBeenCalledTimes(1);
    expect(sortRows(rows.chapterMentions)).toEqual(sortRows([
      { elementId: 'alice', chapterId: 'ch1', mentions: 4 },
      { elementId: 'alice', chapterId: 'ch2', mentions: 1 },
      { elementId: 'bob', chapterId: 'ch1', mentions: 2 },
      { elementId: 'bob', chapterId: 'ch2', mentions: 2 },
      { elementId: 'carol', chapterId: 'ch1', mentions: 4 },
      { elementId: 'carol', chapterId: 'ch2', mentions: 2 },
    ]));
    expect(sortRows(rows.pairs)).toEqual(sortRows([
      { elementA: 'alice', elementB: 'bob', blocks: 2 },
      { elementA: 'alice', elementB: 'carol', blocks: 1 },
      { elementA: 'bob', elementB: 'carol', blocks: 2 },
    ]));

    const graph = buildElementMentionGraph(rows);
    expect(graph.elements.get('alice')?.mentions).toBe(5);
    expect(graph.elements.get('bob')?.mentions).toBe(4);
    expect(graph.elements.get('carol')?.mentions).toBe(6);
    expect([...graph.elements.get('carol')!.byChapter]).toEqual(expect.arrayContaining([['ch1', 4], ['ch2', 2]]));
    expect(graph.elements.has('dave-trashed')).toBe(false);
    expect(graph.elements.has('eve')).toBe(false);
    expect(Object.fromEntries(graph.pairs)).toEqual({ 'alice|bob': 2, 'alice|carol': 1, 'bob|carol': 2 });
  });

  it('counts a paragraph once per pair even if one element has duplicate rows in it', async () => {
    const { db } = await createDatabase();
    await db.insert(InlineMentionTable).values([
      mention('ch1', 'p1', 'alice', spans(4)),
      mention('ch1', 'p1', 'alice'),
      mention('ch1', 'p1', 'bob', spans(2)),
    ]);
    const rows = await readElementMentionGraphRows(PROJECT, db);
    expect(rows.pairs).toEqual([{ elementA: 'alice', elementB: 'bob', blocks: 1 }]);
  });

  it('isolates projects and returns nothing for an empty or unknown project', async () => {
    const { db } = await createDatabase();
    await db.insert(InlineMentionTable).values(SCENARIO);
    expect(await readElementMentionGraphRows(OTHER, db)).toEqual({
      chapterMentions: expect.arrayContaining([
        { elementId: 'eve', chapterId: 'ch-other', mentions: 1 },
        { elementId: 'frank', chapterId: 'ch-other', mentions: 1 },
      ]),
      pairs: [{ elementA: 'eve', elementB: 'frank', blocks: 1 }],
    });
    expect(await readElementMentionGraphRows('project-missing', db)).toEqual({ chapterMentions: [], pairs: [] });
  });
});

describe('element mention graph fold', () => {
  it('keys pairs in JS string order whatever order SQLite returned, and drops empty rows', () => {
    const graph = buildElementMentionGraph({
      chapterMentions: [
        { elementId: 'z', chapterId: 'c1', mentions: 2 },
        { elementId: 'z', chapterId: 'c2', mentions: 3 },
        { elementId: 'y', chapterId: 'c1', mentions: 0 },
      ],
      pairs: [
        { elementA: 'z', elementB: 'a', blocks: 2 },
        { elementA: 'a', elementB: 'a', blocks: 9 },
        { elementA: 'b', elementB: 'c', blocks: 0 },
      ],
    });
    expect(graph.elements.get('z')).toEqual({ mentions: 5, byChapter: new Map([['c1', 2], ['c2', 3]]) });
    expect(graph.elements.has('y')).toBe(false);
    expect([...graph.pairs]).toEqual([['a|z', 2]]);
    expect(elementMentionPairKey('b', 'a')).toBe(elementMentionPairKey('a', 'b'));
  });

  it('derives the refresh scope from live chapters and elements only, ignoring order', () => {
    const chapter = (id: string, kind: 'chapter' | 'drift') => ({ id, kind }) as BookNode;
    const element = (id: string) => ({ id }) as BookElement;
    const key = elementMentionScopeKey([chapter('c2', 'chapter'), chapter('c1', 'chapter'), chapter('d', 'drift')], [element('b'), element('a')]);
    expect(elementMentionScopeKey([chapter('c1', 'chapter'), chapter('c2', 'chapter')], [element('a'), element('b')])).toBe(key);
    expect(elementMentionScopeKey([chapter('c1', 'chapter'), chapter('c2', 'drift')], [element('a'), element('b')])).not.toBe(key);
    expect(elementMentionScopeKey([chapter('c1', 'chapter'), chapter('c2', 'chapter')], [element('a')])).not.toBe(key);
  });
});
