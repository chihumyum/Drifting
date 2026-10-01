import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { Comment } from '../../domain/comment';
import { buildCommentSourcePreview } from './comment-source-preview';

const comment = { projectId: 'project', targetKind: 'node', targetId: 'chapter', targetBlockId: null, targetBlockIdsJson: '[]', anchorJson: '{}' } as Comment;
const state = {
  bookNodes: [{ id: 'chapter', projectId: 'project', kind: 'chapter', title: 'The arrival' }],
  bookElements: [{ id: 'person', projectId: 'project', name: 'The visitor' }],
  bookElementCategories: [{ id: 'category', projectId: 'project', name: 'People' }],
  storylines: [{ id: 'story', projectId: 'project', name: 'The journey' }],
} as Parameters<typeof buildCommentSourcePreview>[2];
const t = ((key: string) => key) as TFunction;
const preview = (overrides: Partial<Comment> = {}) => buildCommentSourcePreview({ ...comment, ...overrides }, [], state, t);

describe('comment source preview', () => {
  it('keeps the primary source first and deduplicates structural associations', () => {
    const result = buildCommentSourcePreview(comment, [
      { toKind: 'node', toId: 'chapter' }, { toKind: 'element', toId: 'person' },
      { toKind: 'category', toId: 'category' }, { toKind: 'storyline', toId: 'story' },
      { toKind: 'comment', toId: 'other-comment' },
    ], state, t);
    expect(result.entities.map((entity) => entity.name)).toEqual(['The arrival', 'The visitor', 'People', 'The journey']);
    expect(result.entities[0].kind).toBe('nodeEditor.folio.chapter');
    expect(result.hasTextAnchor).toBe(false);
  });

  it('does not resolve another project or invent a source for floating cards', () => {
    expect(preview({ projectId: 'other-project' }).entities[0].name).toBe('reviewPanel.sourceUnavailable');
    expect(preview({ targetId: 'deleted' }).entities[0].name).toBe('reviewPanel.sourceUnavailable');
    expect(preview({ targetKind: null, targetId: null }).entities).toEqual([]);
  });

  it('prefers the exact selected span to whole block snapshots', () => {
    expect(preview({ anchorJson: JSON.stringify({ selectedText: 'The selected sentence.', blockSnapshots: [{ blockId: 'b', blockText: 'Whole paragraph.' }] }) }).text).toBe('The selected sentence.');
    expect(preview({ anchorJson: JSON.stringify({ selectedText: 'Fallback', textAnchor: {
      startBlockId: 'a', endBlockId: 'b', startOffset: 0, endOffset: 4, text: 'Exact\nmulti-block span',
    } }) }).text).toBe('Exact\nmulti-block span');
  });

  it('supports paragraph snapshots and reports missing excerpts without loading live prose', () => {
    expect(preview({ anchorJson: JSON.stringify({ blockSnapshots: [{ blockText: 'First' }, { blockText: 'Second' }] }) }).text).toBe('First\n\nSecond');
    expect(preview({ anchorJson: JSON.stringify({ blockText: 'Older paragraph' }) }).text).toBe('Older paragraph');
    const missing = preview({ anchorJson: 'broken', targetBlockId: 'removed-block' });
    expect(missing.text).toBe('');
    expect(missing.hasTextAnchor).toBe(true);
  });
});
