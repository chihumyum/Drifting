import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, Plugin, type Transaction } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  const dom = Object.assign(new EventTarget(), { setAttribute: vi.fn(), removeAttribute: vi.fn() });
  const listeners = new Map<string, () => void>();
  let subscriber: (next: AgentDecorationSnapshot) => void;
  let destroyed = false;
  const view = { dom, composing: false, dispatch: vi.fn((tr: Transaction) => { state = state.apply(tr); }) };
  const binding = attachAgentDecorationController({
    editor: {
      get state() { return state; },
      get isDestroyed() { return destroyed; },
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
      get view() { if (destroyed) throw new Error('Destroyed editor view'); return view; },
    } as unknown as Editor,
    entityType: 'node', entityId: 'target',
    store: { getState: () => snapshot, subscribe: (listener) => { subscriber = listener; return unsubscribe; } },
    presentationNeeded: true, revealAnimationEnabled: enabled,
    onReady: vi.fn(), onError,
  });
  return { binding, onError, unsubscribe, dom, view, decorations: () => AgentDiffPluginKey.getState(state)!.find(),
    update: () => listeners.get('update')?.(),
    publish: (next: AgentDecorationSnapshot) => subscriber(next), destroy: () => { destroyed = true; } };
}

afterEach(() => vi.useRealTimers());

describe('Agent decoration composition ownership', () => {
  const snapshot = (): AgentDecorationSnapshot => ({ pending: {}, additions: {},
    autoRevealGuards: { review: { entityType: 'node', id: 'target', reviewId: 'review', blockIds: ['auto'] } } });

  it('defers updates from the native capture event, before PM marks itself composing', () => {
    vi.useFakeTimers();
    const f = fixture(snapshot());
    f.view.dispatch.mockClear();
    f.dom.dispatchEvent(new Event('compositionstart'));
    f.update();
    expect(f.view.dispatch).not.toHaveBeenCalled();
    expect(f.decorations().some(d => d.spec.agentAutoRevealMask)).toBe(true);
    f.dom.dispatchEvent(new Event('compositionend'));
    expect(f.view.dispatch).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(f.view.dispatch).toHaveBeenCalledOnce();
    f.binding.dispose();
  });

  it('still installs required new review masks during composition', () => {
    const f = fixture({ pending: {}, additions: {}, autoRevealGuards: {} });
    f.dom.dispatchEvent(new Event('compositionstart'));
    f.publish(snapshot());
    expect(f.decorations().some(d => d.spec.agentAutoRevealMask)).toBe(true);
    f.binding.dispose();
  });

  it('a subsequent composition cancels the previous flush and blur releases the native guard', () => {
    vi.useFakeTimers();
    const f = fixture(snapshot());
    f.view.dispatch.mockClear();
    f.dom.dispatchEvent(new Event('compositionstart')); f.update();
    f.dom.dispatchEvent(new Event('compositionend'));
    f.dom.dispatchEvent(new Event('compositionstart'));
    vi.runAllTimers();
    expect(f.view.dispatch).not.toHaveBeenCalled();
    f.dom.dispatchEvent(new Event('blur'));
    vi.runAllTimers();
    expect(f.view.dispatch).toHaveBeenCalledOnce();
    f.binding.dispose();
  });

  it('disposes listeners and pending work even after the editor was destroyed', () => {
    vi.useFakeTimers();
    const f = fixture(snapshot());
    f.dom.dispatchEvent(new Event('compositionstart')); f.update();
    f.dom.dispatchEvent(new Event('compositionend'));
    f.view.dispatch.mockClear();
    f.destroy(); f.binding.dispose();
    f.dom.dispatchEvent(new Event('compositionend'));
    expect(vi.getTimerCount()).toBe(0);
    expect(f.view.dispatch).not.toHaveBeenCalled();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
});

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
