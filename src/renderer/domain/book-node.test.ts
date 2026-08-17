import { describe, expect, it } from 'vitest';

import type { BookNode } from './book-node';
import {
  canonicalWordCount,
  compareBookOrder,
  hasCanonicalWordCount,
  sumCanonicalChapterWordCounts,
} from './book-node';

const hash = `sha256:${'a'.repeat(64)}`;

function node(id: string, kind: 'chapter' | 'drift', overrides: Partial<BookNode> = {}): BookNode {
  return {
    id,
    projectId: 'project-1',
    title: id,
    summary: '',
    kind,
    bookOrder: kind === 'chapter' ? 1 : null,
    narrativeOrder: null,
    driftGroupId: null,
    position: { x: 0, y: 0 },
    writingStatus: kind === 'chapter' ? 'draft' : 'active',
    wordCount: 0,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  } as BookNode;
}

describe('canonical BookNode word metrics', () => {
  it('never exposes a legacy scalar as exact', () => {
    const legacy = node('legacy', 'chapter', { wordCount: 900 });
    const malformed = node('malformed', 'chapter', {
      wordCount: 900,
      wordCountBasisKind: 'seed',
      wordCountBasisHash: 'sha256:stale',
    });

    expect(hasCanonicalWordCount(legacy)).toBe(false);
    expect(canonicalWordCount(legacy)).toBeNull();
    expect(hasCanonicalWordCount(malformed)).toBe(false);
    expect(canonicalWordCount(malformed)).toBeNull();
  });

  it('accepts explicit seed and local/server Yjs bases', () => {
    const seed = node('seed', 'chapter', {
      wordCount: 0,
      wordCountBasisKind: 'seed',
      wordCountBasisHash: hash,
    });
    const local = node('local', 'chapter', {
      wordCount: 12,
      wordCountBasisKind: 'yjs',
      wordCountBasisHash: hash,
      wordCountBasisRevision: 4,
    });
    const server = node('server', 'chapter', {
      wordCount: 15,
      wordCountBasisKind: 'yjs',
      wordCountBasisHash: hash,
      wordCountBasisServerSeq: 9,
    });

    expect([seed, local, server].map(canonicalWordCount)).toEqual([0, 12, 15]);
  });

  it('keeps project totals chapter-only and pending until every chapter is exact', () => {
    const exactChapter = node('chapter-1', 'chapter', {
      wordCount: 12,
      wordCountBasisKind: 'seed',
      wordCountBasisHash: hash,
    });
    const legacyChapter = node('chapter-2', 'chapter', { wordCount: 500 });
    const legacyDrift = node('drift-1', 'drift', { wordCount: 999 });

    expect(sumCanonicalChapterWordCounts([exactChapter, legacyChapter, legacyDrift])).toEqual({
      count: 12,
      ready: false,
    });
    expect(sumCanonicalChapterWordCounts([exactChapter, legacyDrift])).toEqual({
      count: 12,
      ready: true,
    });
  });
});

describe('continuous book order', () => {
  it('sorts real coordinates and uses stable IDs when coordinates tie', () => {
    const chapters = [
      node('chapter-b', 'chapter', { bookOrder: 2.25 }),
      node('chapter-c', 'chapter', { bookOrder: 1.125 }),
      node('chapter-a', 'chapter', { bookOrder: 2.25 }),
    ];

    expect(chapters.sort(compareBookOrder).map(({ id }) => id)).toEqual([
      'chapter-c',
      'chapter-a',
      'chapter-b',
    ]);
  });
});
