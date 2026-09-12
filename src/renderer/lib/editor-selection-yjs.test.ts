import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { initProseMirrorDoc, ySyncPlugin, ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { getEditorSelectionSnapshot, pruneEditorSelectionMemory, saveEditorSelectionSnapshot } from './editor-selection-memory';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null } } }, text: { group: 'inline' },
}, marks: { bold: {} } });
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); pruneEditorSelectionMemory('synthetic', []); });
function paragraph(id: string, text: string) {
  const element = new Y.XmlElement<{ id: string }>('paragraph');
  element.setAttribute('id', id); element.insert(0, [new Y.XmlText(text)]); return element;
}
function fixture(anchor = 30, head = 20) {
  const ydoc = new Y.Doc(); const fragment = ydoc.getXmlFragment('default');
  const block = paragraph('target', 'Synthetic collaboration selection. '.repeat(4));
  fragment.insert(0, [block, paragraph('sibling', 'A separate synthetic paragraph.')]);
  const { doc, mapping } = initProseMirrorDoc(fragment, schema);
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head), plugins: [ySyncPlugin(fragment, { mapping })] });
  // Real Yjs sync plugin and immutable PM transactions; only browser view/focus
  // is doubled. The native composition separately exercises the actual view.
  const view = { state, hasFocus: () => false, dispatch(tr: Transaction) {
    this.state = this.state.apply(tr);
    saveEditorSelectionSnapshot('synthetic:node:target', { state: this.state, isDestroyed: false } as Editor);
  } };
  const binding = ySyncPluginKey.getState(state).binding;
  binding.initView(view as unknown as EditorView);
  cleanups.push(() => { binding.destroy(); ydoc.destroy(); });
  return { ydoc, fragment, block, text: block.get(0) as Y.XmlText, view };
}

describe('Yjs selection continuity with position-only memory', () => {
  it.each([[30, 20], [20, 30], [25, 25]])('maps a hidden authored prefix for anchor/head %i/%i and restores after deletion', (anchor, head) => {
    const f = fixture(anchor, head); const prefix = 'Inserted prefix. ';
    f.ydoc.transact(() => f.text.insert(0, prefix), 'agent');
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: anchor + prefix.length, head: head + prefix.length });
    expect(getEditorSelectionSnapshot('synthetic:node:target')).toEqual({ anchor: anchor + prefix.length, head: head + prefix.length, focusOnRestore: true });
    f.ydoc.transact(() => f.text.delete(0, prefix.length), 'agent');
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor, head });
  });

  it('maps peer insert/delete updates through real Y.applyUpdate without changing direction', () => {
    const f = fixture(); const peer = new Y.Doc(); cleanups.push(() => peer.destroy());
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.ydoc));
    const peerText = (peer.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText;
    peerText.insert(0, 'peer '); Y.applyUpdate(f.ydoc, Y.encodeStateAsUpdate(peer), 'synthetic-peer');
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: 35, head: 25 });
    peerText.delete(0, 10); Y.applyUpdate(f.ydoc, Y.encodeStateAsUpdate(peer), 'synthetic-peer');
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: 25, head: 15 });
  });

  it('keeps positions for mark-only updates and collapses a fully deleted range safely', () => {
    const f = fixture();
    f.ydoc.transact(() => f.text.format(0, 40, { bold: {} }), 'agent');
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: 30, head: 20 });
    f.ydoc.transact(() => f.text.delete(10, 30), 'agent');
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: 11, head: 11 });
  });

  it('retains structural recovery for block insertion and delete/reinsert moves', () => {
    const f = fixture(); const prefix = paragraph('prefix', 'New block.');
    f.ydoc.transact(() => f.fragment.insert(0, [prefix]), 'agent');
    const shift = 'New block.'.length + 2;
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: 30 + shift, head: 20 + shift });
    const moved = f.block.clone();
    f.ydoc.transact(() => { f.fragment.delete(1, 1); f.fragment.insert(f.fragment.length, [moved]); }, 'agent');
    const movedStart = f.view.state.doc.child(0).nodeSize + f.view.state.doc.child(1).nodeSize;
    expect(f.view.state.selection.toJSON()).toEqual({ type: 'text', anchor: movedStart + 30, head: movedStart + 20 });
  });

  it('falls back to a valid selection when the selected block is deleted', () => {
    const f = fixture(); f.ydoc.transact(() => f.fragment.delete(0, 1), 'agent');
    const selection = f.view.state.selection;
    expect(selection.$anchor.parent.isTextblock).toBe(true); expect(selection.$head.parent.isTextblock).toBe(true);
    expect(selection.from).toBeGreaterThanOrEqual(1); expect(selection.to).toBeLessThan(f.view.state.doc.content.size);
  });
});
