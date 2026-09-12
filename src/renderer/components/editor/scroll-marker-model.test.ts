import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { Comment } from '../../domain/comment';
import type { AgentBlockChange } from '../../lib/agent/block-diff';
import { createAgentMarkerSelector, createCommentMarkerSelector, sameScrollMarkers } from './scroll-marker-model';

function comment(patch: Partial<Comment> = {}): Comment {
  return { id: 'c', projectId: 'p', kind: 'note', targetKind: 'node', targetId: 'n', targetBlockId: 'b',
    targetBlockIdsJson: '[]', anchorJson: '{}', authorKind: 'user', authorId: null, authorName: null,
    bodyJson: '{}', status: 'open', priority: null, source: 'manual', metadataJson: null,
    resolvedAt: null, createdAt: '', updatedAt: '', ...patch };
}
function change(patch: Partial<AgentBlockChange> = {}): AgentBlockChange {
  return { blockId: 'b', op: 'changed', oldText: 'old', newText: 'new', afterPrevId: null, ...patch };
}

describe('scoped scrollbar marker projections', () => {
  it('requires explicit rail membership and the current project/entity/anchor', () => {
    const comments = [comment(), comment({ id: 'hidden' }), comment({ id: 'p2', projectId: 'q' }),
      comment({ id: 'kind', targetKind: 'element' }), comment({ id: 'entity', targetId: 'm' }),
      comment({ id: 'floating', targetBlockId: null }), comment({ id: 'converted', status: 'converted' })];
    expect(createCommentMarkerSelector('p', 'node', 'n', comments.map(c => c.id).filter(id => id !== 'hidden'))({ comments }).map(c => c.key)).toEqual(['c:c']);
    expect(createCommentMarkerSelector('p', 'node', 'n', [])({ comments })).toEqual([]);
  });

  it('retains original collection order and handles malformed, multi-block and duplicate membership', () => {
    const comments = [comment({ targetBlockIdsJson: 'invalid' }), comment({ id: 'multi', targetBlockIdsJson: '["a","b",null,""]' })];
    const rows = createCommentMarkerSelector('p', 'node', 'n', ['multi', 'c', 'c'])({ comments });
    expect(rows.map(c => [c.key, c.blockIds])).toEqual([['c:c', ['b']], ['c:multi', ['a', 'b']]]);
  });

  it('keeps subscriber snapshots stable for unrelated comments and non-marker field updates', () => {
    const select = createCommentMarkerSelector('p', 'node', 'n', ['c']);
    const store = createStore(() => ({ comments: [comment()] }));
    let snapshot = select(store.getState()); let notifications = 0;
    const off = store.subscribe(state => { const next = select(state); if (next !== snapshot) { snapshot = next; notifications++; } });
    store.setState({ comments: [comment({ bodyJson: 'new body', priority: 'high', updatedAt: 'later' }), comment({ id: 'other' })] });
    expect(notifications).toBe(0);
    store.setState({ comments: [comment({ targetBlockIdsJson: '["b","c"]' })] });
    expect(notifications).toBe(1); expect(snapshot[0].blockIds).toEqual(['b', 'c']);
    store.setState({ comments: [comment({ status: 'resolved' })] });
    expect(snapshot[0].cls).toBe('editor__scrollmap-tick--resolved');
    store.setState({ comments: [] }); expect(snapshot).toEqual([]); off();
  });

  it('updates family and title independently of geometry and cannot mix projects/generations', () => {
    const select = createCommentMarkerSelector('p', 'node', 'n', ['c']);
    const original = select({ comments: [comment()] });
    const todo = select({ comments: [comment({ kind: 'todo' })] });
    expect(todo[0]).toMatchObject({ titleKey: 'editorScrollMarkers.jumpToTodo', cls: 'editor__scrollmap-tick--c-todo' });
    expect(sameScrollMarkers(original, todo)).toBe(false);
    expect(select({ comments: [comment({ projectId: 'q' })] })).toEqual([]);
    expect(select({ comments: [comment({ source: 'copilot' })] })[0].cls).toBe('editor__scrollmap-tick--c-copilot');
  });

  it('projects prose operations and ignores text, mode and review provenance changes', () => {
    const select = createAgentMarkerSelector();
    const original = select([change(), change({ blockId: 'new', op: 'new' }), change({ blockId: 'gone', op: 'deleted', afterPrevId: 'b' })]);
    expect(original.map(c => [c.laneCls, c.blockIds])).toEqual([
      ['editor__scrollmap-tick--lane1', ['b']], ['editor__scrollmap-tick--lane0', ['new']], ['editor__scrollmap-tick--lane2', ['b']],
    ]);
    expect(select([change({ newText: 'streamed', reviewId: 'review', mode: 'approve' }), change({ blockId: 'new', op: 'new' }), change({ blockId: 'gone', op: 'deleted', afterPrevId: 'b' })])).toBe(original);
    expect(select([change({ op: 'deleted' })])[0].blockIds).toEqual([]);
    expect(select(undefined)).toEqual([]);
  });

  it('removes field changes even when their old op/id/predecessor signature is unchanged', () => {
    const select = createAgentMarkerSelector();
    expect(select([change({ op: 'deleted' })])).toHaveLength(1);
    expect(select([change({ op: 'deleted', field: { kind: 'summary', label: 'Summary' } })])).toEqual([]);
    expect(select([change({ op: 'deleted', afterPrevId: 'current' })])[0].blockIds).toEqual(['current']);
  });
});
