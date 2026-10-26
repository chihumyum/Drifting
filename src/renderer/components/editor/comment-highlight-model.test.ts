import { describe, expect, it } from 'vitest';
import type { Comment } from '../../domain/comment';
import { commentHighlightNames, sameRangeList } from '../../lib/comment-highlight';
import { createCommentHighlightSelector } from './comment-highlight-model';

function comment(patch: Partial<Comment> = {}): Comment {
  return { id: 'c', projectId: 'p', kind: 'note', targetKind: 'node', targetId: 'n', targetBlockId: 'b',
    targetBlockIdsJson: '[]', anchorJson: '{}', authorKind: 'user', authorId: null, authorName: null,
    bodyJson: '{}', status: 'open', priority: null, source: 'manual', metadataJson: null,
    resolvedAt: null, createdAt: '', updatedAt: '', ...patch };
}

describe('comment anchor highlight candidates', () => {
  it('admits block-anchored comments of the surface target regardless of rail membership', () => {
    const comments = [comment(), comment({ id: 'resolved', status: 'resolved' }),
      comment({ id: 'p2', projectId: 'q' }), comment({ id: 'kind', targetKind: 'element' }),
      comment({ id: 'entity', targetId: 'm' }), comment({ id: 'floating', targetBlockId: null }),
      comment({ id: 'converted', status: 'converted' })];
    expect(createCommentHighlightSelector('p', 'node', 'n')({ comments }).map((c) => c.id))
      .toEqual(['c', 'resolved']);
  });

  it('admits every target of the kind for the whole-book reader', () => {
    const comments = [comment(), comment({ id: 'other-chapter', targetId: 'm' }),
      comment({ id: 'element', targetKind: 'element' })];
    expect(createCommentHighlightSelector('p', 'node', null)({ comments }).map((c) => c.id))
      .toEqual(['c', 'other-chapter']);
  });

  it('keeps the snapshot stable until a candidate changes', () => {
    const select = createCommentHighlightSelector('p', 'node', 'n');
    const kept = comment();
    const first = select({ comments: [kept] });
    expect(select({ comments: [kept, comment({ id: 'elsewhere', targetId: 'm' })] })).toBe(first);
    expect(select({ comments: [comment({ status: 'resolved' })] })).not.toBe(first);
    expect(select({ comments: [] })).toEqual([]);
  });
});

describe('comment anchor highlight layers', () => {
  it('washes unresolved notes and TODOs but leaves Copilot proposals quiet', () => {
    expect(commentHighlightNames(comment(), null)).toEqual(['comment-hl-manual']);
    expect(commentHighlightNames(comment({ kind: 'todo' }), null)).toEqual(['comment-hl-todo']);
    expect(commentHighlightNames(comment({ source: 'copilot' }), null)).toEqual([]);
    expect(commentHighlightNames(comment({ status: 'resolved' }), null)).toEqual([]);
  });

  it('adds the active overlay for the hovered card, including resolved and Copilot items', () => {
    expect(commentHighlightNames(comment(), 'c')).toEqual(['comment-hl-manual', 'comment-hl-manual-active']);
    expect(commentHighlightNames(comment({ status: 'resolved', kind: 'todo' }), 'c'))
      .toEqual(['comment-hl-todo-active']);
    expect(commentHighlightNames(comment({ source: 'copilot' }), 'c')).toEqual(['comment-hl-copilot-active']);
    expect(commentHighlightNames(comment({ status: 'converted' }), 'c')).toEqual([]);
    expect(commentHighlightNames(comment(), 'other')).toEqual(['comment-hl-manual']);
  });

  it('compares painted ranges positionally', () => {
    const same = (a: number, b: number) => a === b;
    expect(sameRangeList([1, 2], [1, 2], same)).toBe(true);
    expect(sameRangeList([1, 2], [2, 1], same)).toBe(false);
    expect(sameRangeList([1], [1, 2], same)).toBe(false);
  });
});
