import { describe, expect, it } from 'vitest';

import type { BookNode, ChapterNode } from '../domain/book-node';
import { deriveStatusWordMetric } from './status-word-metric';

const chapter = (id: string, wordCount: number): ChapterNode => ({
  id, projectId: 'p', kind: 'chapter', title: id, summary: '', bookOrder: 1, narrativeOrder: null,
  driftGroupId: null, position: { x: 0, y: 0 }, wordCount, wordCountBasisKind: 'yjs',
  wordCountBasisHash: `sha256:${'a'.repeat(64)}`, wordCountBasisRevision: 1,
  writingStatus: 'draft', createdAt: '', updatedAt: '',
});
const bookNodes: BookNode[] = [chapter('c1', 1200), chapter('c2', 800)];
const base = {
  selectedWordCount: null,
  wholeBookEditingChapterId: null,
  bookNodes,
  storylineNodeMapping: { s1: ['c2'] },
  projectWordCount: { count: 2000, ready: true },
};
const wholeBook = { entityType: 'all-chapters', id: 'singleton' };

describe('deriveStatusWordMetric', () => {
  it('shows the book in 通览全书 while no chapter is being edited', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook }))
      .toEqual({ labelKey: 'bottomStatusBar.projectWords', count: 2000 });
  });

  it('shows the chapter being edited in 通览全书', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook, wholeBookEditingChapterId: 'c1' }))
      .toEqual({ labelKey: 'bottomStatusBar.currentWords', count: 1200 });
  });

  it('falls back to the book when the edited chapter is gone', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook, wholeBookEditingChapterId: 'deleted' }))
      .toEqual({ labelKey: 'bottomStatusBar.projectWords', count: 2000 });
  });

  it('ignores a whole-book chapter while another tab is active', () => {
    expect(deriveStatusWordMetric({
      ...base,
      activeLeaf: { entityType: 'storyline', id: 's1' },
      wholeBookEditingChapterId: 'c1',
    })).toEqual({ labelKey: 'bottomStatusBar.storylineWords', count: 800 });
  });

  it('keeps the selection and the open chapter tab first', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook, wholeBookEditingChapterId: 'c1', selectedWordCount: 12 }))
      .toEqual({ labelKey: 'bottomStatusBar.selectedWords', count: 12 });
    expect(deriveStatusWordMetric({ ...base, activeLeaf: { entityType: 'node', id: 'c2' } }))
      .toEqual({ labelKey: 'bottomStatusBar.currentWords', count: 800 });
  });
});
