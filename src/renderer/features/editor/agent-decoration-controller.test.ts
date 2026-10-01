import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, Plugin, type Transaction } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import { describe, expect, it, vi } from 'vitest';
import { AgentDiffPluginKey } from '../../lib/extensions/agent-diff-decoration';
import { attachAgentDecorationController } from './agent-decoration-controller';
import type { AgentDecorationSnapshot } from './agent-decoration-projection';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null } } },
} });

function fixture(snapshot: AgentDecorationSnapshot, enabled = true) {
  const doc = schema.node('doc', null, ['auto', 'approve'].map((id) =>
    schema.node('paragraph', { id }, schema.text(`Synthetic ${id}`))));
  let state = EditorState.create({ doc, plugins: [new Plugin({
    key: AgentDiffPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, value) => tr.getMeta(AgentDiffPluginKey) ?? value.map(tr.mapping, tr.doc),
    },
  })] });
  const unsubscribe = vi.fn();
  const onError = vi.fn();
  const binding = attachAgentDecorationController({
    editor: {
      get state() { return state; },
      isDestroyed: false,
      on: vi.fn(), off: vi.fn(),
      view: {
        dom: { setAttribute: vi.fn(), removeAttribute: vi.fn() },
        dispatch: (tr: Transaction) => { state = state.apply(tr); },
      },
    } as unknown as Editor,
    entityType: 'node', entityId: 'target',
    store: { getState: () => snapshot, subscribe: () => unsubscribe },
    presentationNeeded: true, revealAnimationEnabled: enabled,
    onReady: vi.fn(), onError,
  });
  return { binding, onError, unsubscribe, decorations: () => AgentDiffPluginKey.getState(state)!.find() };
}

describe('Agent reveal appearance preference', () => {
  it('removes live prose masks immediately while preserving approval diffs and pending edits', () => {
    const changes = ['auto', 'approve'].map((mode) => ({
      blockId: mode, mode: mode as 'auto' | 'approve', op: 'new' as const,
      oldText: '', newText: `Synthetic ${mode}`, afterPrevId: null,
    }));
    const state = { pending: { 'node:target': { entityType: 'node' as const, id: 'target', changes } }, additions: {}, autoRevealGuards: {} };
    const f = fixture(state);
    expect(f.decorations().filter((d) => d.spec.agentAutoRevealMask)).toHaveLength(1);
    f.binding.setRevealAnimationEnabled(false);
    expect(f.decorations().filter((d) => d.spec.agentAutoRevealMask)).toHaveLength(0);
    expect(f.decorations()).toHaveLength(1); // the approve-mode green inline diff
    expect(state.pending['node:target'].changes).toEqual(changes);
    f.binding.setRevealAnimationEnabled(true);
    expect(f.decorations().filter((d) => d.spec.agentAutoRevealMask)).toHaveLength(1);
    expect(f.onError).not.toHaveBeenCalled();
    f.binding.dispose();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['guard', 'added'] as const)('does not hide %s prose when animation starts disabled', (kind) => {
    const f = fixture({
      pending: {},
      additions: kind === 'added' ? { 'node:target': { entityType: 'node', id: 'target', revealBlockIds: null } } : {},
      autoRevealGuards: kind === 'guard' ? { review: { entityType: 'node', id: 'target', reviewId: 'review', blockIds: ['auto'] } } : {},
    }, false);
    expect(f.decorations()).toEqual([]);
    expect(f.onError).not.toHaveBeenCalled();
    f.binding.dispose();
  });
});
