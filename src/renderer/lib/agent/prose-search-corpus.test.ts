import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDataStore } from '../../store/data-store';
import type { NodeContent } from '../../domain/node-content';
import {
  clearProseSearchCorpusCache,
  collectProseSearchDocuments,
  proseSearchCorpusCacheStats,
  type ProseSearchCorpusDeps,
} from './prose-search-corpus';
import { rankAgentContextEvidence } from './runtime/context-evidence-retrieval';

function proseDoc(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'block-1' },
        content: [{ type: 'text', text }],
      },
    ],
  });
}

const elementFixture = {
  id: 'element-1',
  projectId: 'project-1',
  categoryId: 'category-1',
  name: '柳青',
  summary: '守灯人',
  contentJson: proseDoc('元素正文:守灯人在雨夜擦拭灯罩。'),
  kvJson: '[]',
  aliases: [],
  groupName: null,
  portraitAssetId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function chapterFixture(id: string, title: string, bookOrder: number) {
  return {
    id,
    projectId: 'project-1',
    kind: 'chapter' as const,
    title,
    summary: '',
    bookOrder,
    narrativeOrder: bookOrder,
    driftGroupId: null,
    position: { x: 0, y: 0 },
    wordCount: 10,
    writingStatus: 'draft' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function contentRow(nodeId: string, text: string): NodeContent {
  return {
    nodeId,
    contentJson: proseDoc(text),
    outlineJson: '[]',
    plotGridJson: '{}',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  };
}

interface Harness {
  deps: ProseSearchCorpusDeps;
  materialized: string[];
  loads: { nodeContents: number; revisions: number };
  contents: Map<string, NodeContent>;
  revisions: Map<string, number> | null;
  liveDocIds: Set<string>;
}

function makeHarness(): Harness {
  const harness: Harness = {
    materialized: [],
    loads: { nodeContents: 0, revisions: 0 },
    contents: new Map(),
    revisions: new Map(),
    liveDocIds: new Set(),
    deps: {
      loadNodeContents: async () => {
        harness.loads.nodeContents += 1;
        return harness.contents;
      },
      loadRevisions: async () => {
        harness.loads.revisions += 1;
        return harness.revisions;
      },
      materialize: async (entityType, id, cacheJson) => {
        harness.materialized.push(`${entityType}:${id}`);
        return cacheJson;
      },
      hasLiveDoc: (docId) => harness.liveDocIds.has(docId),
    },
  };
  return harness;
}

function seedStore(): void {
  useDataStore.setState({
    storylines: [],
    bookElementCategories: [],
    bookElements: [elementFixture],
    bookNodes: [chapterFixture('node-1', '第一章', 1), chapterFixture('node-2', '第二章', 2)],
  });
}

describe('prose search corpus', () => {
  beforeEach(() => {
    clearProseSearchCorpusCache();
    seedStore();
  });

  afterEach(() => {
    clearProseSearchCorpusCache();
    useDataStore.setState({
      storylines: [],
      bookElementCategories: [],
      bookElements: [],
      bookNodes: [],
    });
  });

  it('materializes once, then serves unchanged revisions from the cache', async () => {
    const harness = makeHarness();
    harness.contents.set('node-1', contentRow('node-1', '第一章正文:雨夜里点灯。'));
    // node-2 intentionally has no content row → no prose body to search.

    const first = await collectProseSearchDocuments('project-1', harness.deps);
    expect(harness.materialized).toEqual(['element:element-1', 'node:node-1']);
    expect(first.map((d) => d.evidenceId)).toEqual([
      'element-prose:element-1',
      'chapter-prose:node-1',
    ]);
    expect(first[1]).toMatchObject({
      kind: 'chapter',
      title: '第一章',
      ordinal: 1,
      revision: '2026-01-03T00:00:00.000Z',
      fields: [{ kind: 'prose', block: 1, text: '第一章正文:雨夜里点灯。' }],
    });

    harness.materialized.length = 0;
    const second = await collectProseSearchDocuments('project-1', harness.deps);
    expect(harness.materialized).toEqual([]);
    expect(second).toEqual(first);
  });

  it('rematerializes only the document whose Yjs revision changed', async () => {
    const harness = makeHarness();
    harness.contents.set('node-1', contentRow('node-1', '第一章正文。'));
    await collectProseSearchDocuments('project-1', harness.deps);

    harness.materialized.length = 0;
    harness.revisions?.set('node-content:node-1', 7);
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(harness.materialized).toEqual(['node:node-1']);
  });

  it('invalidates on a projection stamp change even without a Yjs revision row', async () => {
    const harness = makeHarness();
    await collectProseSearchDocuments('project-1', harness.deps);

    harness.materialized.length = 0;
    useDataStore.setState({
      bookElements: [{ ...elementFixture, updatedAt: '2026-02-01T00:00:00.000Z' }],
    });
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(harness.materialized).toEqual(['element:element-1']);
  });

  it('always rematerializes a document with a live editor doc and never caches it', async () => {
    const harness = makeHarness();
    harness.contents.set('node-1', contentRow('node-1', '第一章正文。'));
    harness.liveDocIds.add('node-content:node-1');

    await collectProseSearchDocuments('project-1', harness.deps);
    harness.materialized.length = 0;
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(harness.materialized).toEqual(['node:node-1']);
  });

  it('bypasses caching entirely when revisions are unavailable', async () => {
    const harness = makeHarness();
    harness.revisions = null;
    await collectProseSearchDocuments('project-1', harness.deps);
    harness.materialized.length = 0;
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(harness.materialized).toEqual(['element:element-1']);
    expect(proseSearchCorpusCacheStats()).toEqual({ entries: 0, chars: 0 });
  });

  it('returns an empty corpus without any repository reads', async () => {
    useDataStore.setState({ bookElements: [], bookNodes: [] });
    const harness = makeHarness();
    expect(await collectProseSearchDocuments('project-1', harness.deps)).toEqual([]);
    expect(harness.loads).toEqual({ nodeContents: 0, revisions: 0 });
  });

  it('uses native text for cold durable rows, preserving empty block ordinals and non-node joins', async () => {
    const harness = makeHarness();
    harness.contents.set('node-1', contentRow('node-1', 'stale cache'));
    harness.revisions!.set('node-content:node-1', 7);
    harness.revisions!.set('element:element-1', 9);
    const read = vi.fn(async (ids: readonly string[]) => ids.map(docId => ({ docId,
      revision: harness.revisions!.get(docId)!, blocks: ['Ａ🙂', '', '  ', '尾'] })));
    harness.deps.readClosedText = read;
    const rows = await collectProseSearchDocuments('project-1', harness.deps);
    expect(rows.find(row => row.evidenceId === 'chapter-prose:node-1')!.fields.map(field => [field.block, field.text]))
      .toEqual([[1, 'Ａ🙂'], [2, ''], [3, '  '], [4, '尾']]);
    expect(rows.find(row => row.evidenceId === 'element-prose:element-1')!.fields[0].text).toBe('Ａ🙂\n\n  \n\n尾');
    expect(harness.materialized).toEqual([]);
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(['unsupported', 'revision-race', 'opened-editor', 'failure'])('falls back safely on %s', async (mode) => {
    const harness = makeHarness();
    harness.contents.set('node-1', contentRow('node-1', 'fresh Yjs fallback'));
    harness.revisions!.set('node-content:node-1', 7);
    harness.deps.readClosedText = async ids => {
      if (mode === 'failure') throw new Error('native unavailable');
      if (mode === 'opened-editor') harness.liveDocIds.add('node-content:node-1');
      return ids.map(docId => ({ docId, revision: mode === 'revision-race' ? 8 : 7,
        blocks: mode === 'unsupported' ? null : ['must not use this text'] }));
    };
    const rows = await collectProseSearchDocuments('project-1', harness.deps);
    expect(rows.find(row => row.evidenceId === 'chapter-prose:node-1')!.fields[0].text).toBe('fresh Yjs fallback');
    expect(harness.materialized).toContain('node:node-1');
    if (mode === 'opened-editor') {
      harness.materialized.length = 0;
      await collectProseSearchDocuments('project-1', harness.deps);
      expect(harness.materialized).toContain('node:node-1');
    }
  });

  it('bounds native captures and bypasses seed-only, live and unavailable-revision documents', async () => {
    const harness = makeHarness();
    useDataStore.setState({ bookElements: [], bookNodes: Array.from({ length: 35 }, (_, i) => chapterFixture(`n${i}`, 'Synthetic', i)) });
    for (let i = 0; i < 35; i++) {
      harness.contents.set(`n${i}`, contentRow(`n${i}`, 'body'));
      if (i > 0) harness.revisions!.set(`node-content:n${i}`, 1);
    }
    harness.liveDocIds.add('node-content:n1');
    const read = vi.fn(async (ids: readonly string[]) => ids.map(docId => ({ docId, revision: 1, blocks: ['body'] })));
    harness.deps.readClosedText = read;
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([16, 16, 1]);
    expect(harness.materialized).toEqual(['node:n0', 'node:n1']);
    clearProseSearchCorpusCache(); harness.revisions = null; read.mockClear();
    await collectProseSearchDocuments('project-1', harness.deps);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps the cache under its character budget by evicting oldest entries', async () => {
    useDataStore.setState({ bookElements: [] });
    const harness = makeHarness();
    // Each entry costs text + normalized ≈ 4.4M chars against the 8M budget,
    // so only the most recent entry can remain resident.
    harness.contents.set('node-1', contentRow('node-1', 'a'.repeat(2_200_000)));
    harness.contents.set('node-2', contentRow('node-2', 'b'.repeat(2_200_000)));

    await collectProseSearchDocuments('project-1', harness.deps);
    const stats = proseSearchCorpusCacheStats();
    expect(stats.entries).toBe(1);
    expect(stats.chars).toBeLessThanOrEqual(8_000_000);
  });

  it('produces normalized fields the ranker treats identically to plain fields', async () => {
    const harness = makeHarness();
    harness.contents.set(
      'node-1',
      contentRow('node-1', 'ＡＢＣ Mixed ＣＡＳＥ:雨夜里,柳青点亮了一盏灯。🙂'),
    );
    const documents = await collectProseSearchDocuments('project-1', harness.deps);
    for (const document of documents) {
      for (const field of document.fields) expect(field.normalized).toBeDefined();
    }
    const plain = documents.map((document) => ({
      ...document,
      fields: document.fields.map(({ normalized: _normalized, ...field }) => field),
    }));

    for (const query of ['abc mixed', '雨夜 柳青', 'ＣＡＳＥ']) {
      expect(rankAgentContextEvidence({ query, documents })).toEqual(
        rankAgentContextEvidence({ query, documents: plain }),
      );
    }
  });
});
