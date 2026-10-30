import { describe, expect, it } from 'vitest';

import type { BookNode, ChapterNode, DriftNode } from '../domain/book-node';
import { dailyGoalProgress, deriveStatusWordMetric } from './status-word-metric';

const chapter = (id: string, wordCount: number): ChapterNode => ({
  id, projectId: 'p', kind: 'chapter', title: id, summary: '', bookOrder: 1, narrativeOrder: null,
  driftGroupId: null, position: { x: 0, y: 0 }, wordCount, wordCountBasisKind: 'yjs',
  wordCountBasisHash: `sha256:${'a'.repeat(64)}`, wordCountBasisRevision: 1,
  writingStatus: 'draft', createdAt: '', updatedAt: '',
});
const drift = (id: string, wordCount: number): DriftNode => ({
  ...chapter(id, wordCount), kind: 'drift', bookOrder: null, writingStatus: 'drifting',
});
const bookNodes: BookNode[] = [chapter('c1', 1200), chapter('c2', 800), drift('d1', 90)];
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
      .toEqual({ kind: 'book', count: 2000 });
  });

  it('shows the chapter being edited in 通览全书', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook, wholeBookEditingChapterId: 'c1' }))
      .toEqual({ kind: 'chapter', count: 1200 });
  });

  it('falls back to the book when the edited chapter is gone', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook, wholeBookEditingChapterId: 'deleted' }))
      .toEqual({ kind: 'book', count: 2000 });
  });

  it('ignores a whole-book chapter while another tab is active', () => {
    expect(deriveStatusWordMetric({
      ...base,
      activeLeaf: { entityType: 'storyline', id: 's1' },
      wholeBookEditingChapterId: 'c1',
    })).toEqual({ kind: 'storyline', count: 800 });
  });

  it('keeps the selection and the open chapter tab first', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: wholeBook, wholeBookEditingChapterId: 'c1', selectedWordCount: 12 }))
      .toEqual({ kind: 'selection', count: 12 });
    expect(deriveStatusWordMetric({ ...base, activeLeaf: { entityType: 'node', id: 'c2' } }))
      .toEqual({ kind: 'chapter', count: 800 });
  });

  it('names an open idea apart from a chapter', () => {
    expect(deriveStatusWordMetric({ ...base, activeLeaf: { entityType: 'node', id: 'd1' } }))
      .toEqual({ kind: 'drift', count: 90 });
  });
});

describe('dailyGoalProgress', () => {
  it('reads today against the daily goal and stops at the goal', () => {
    expect(dailyGoalProgress(300, 1500)).toBeCloseTo(0.2);
    expect(dailyGoalProgress(2400, 1500)).toBe(1);
    expect(dailyGoalProgress(0, 1500)).toBe(0);
  });

  it('draws nothing without a goal or while today is being counted', () => {
    expect(dailyGoalProgress(300, 0)).toBeNull();
    expect(dailyGoalProgress(null, 1500)).toBeNull();
  });
});
