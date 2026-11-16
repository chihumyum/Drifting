import { Schema } from '@tiptap/pm/model';
import { EditorState, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { initProseMirrorDoc, redo, undo, ySyncPlugin, ySyncPluginKey, yUndoPlugin, yUndoPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null } } }, text: { group: 'inline' },
}, marks: { bold: {} } });
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

function paragraph(id: string, text: string) {
  const element = new Y.XmlElement<{ id: string }>('paragraph');
  element.setAttribute('id', id); element.insert(0, [new Y.XmlText(text)]); return element;
}

const FIRST = 'Synthetic undo text.';
const SECOND = 'A second synthetic paragraph.';

/**
 * The real Yjs sync and undo plugins over immutable ProseMirror states. Only
 * the browser view is doubled: `dispatch` applies the transaction and runs
 * each plugin view's `update`, as `EditorView.updateState` does.
 */
function fixture(anchor: number, head = anchor, { extraPlugins = [] as Plugin[], focused = false } = {}) {
  const ydoc = new Y.Doc(); const fragment = ydoc.getXmlFragment('default');
  fragment.insert(0, [paragraph('first', FIRST), paragraph('second', SECOND)]);
  const { doc, mapping } = initProseMirrorDoc(fragment, schema);
  const plugins = [ySyncPlugin(fragment, { mapping }), yUndoPlugin(), ...extraPlugins];
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head), plugins });
  const pluginViews: Array<{ update?: (view: EditorView, prev: EditorState) => void; destroy?: () => void }> = [];
  const view = { state, last: null as Transaction | null, hasFocus: () => focused, dispatch(tr: Transaction) {
    const prev = this.state; this.state = this.state.apply(tr); this.last = tr;
    for (const pluginView of pluginViews) pluginView.update?.(this as unknown as EditorView, prev);
  } };
  for (const plugin of plugins) {
    const pluginView = plugin.spec.view?.(view as unknown as EditorView);
    if (pluginView) pluginViews.push(pluginView);
  }
  const manager = yUndoPluginKey.getState(view.state)!.undoManager as Y.UndoManager;
  cleanups.push(() => { pluginViews.forEach(pluginView => pluginView.destroy?.()); ydoc.destroy(); });
  return {
    ydoc, fragment, view, manager,
    text: () => view.state.doc.child(0).textContent,
    yText: () => (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText,
    selection: () => ({ anchor: view.state.selection.anchor, head: view.state.selection.head }),
    /** One authored edit, closed as its own undo step. */
    edit(build: (tr: Transaction) => Transaction) { view.dispatch(build(view.state.tr)); manager.stopCapturing(); },
    undo: () => undo(view.state), redo: () => redo(view.state),
  };
}

const select = (anchor: number, head: number) => (tr: Transaction) => tr.setSelection(TextSelection.create(tr.doc, anchor, head));
const GAP = 'Synthetic  text.';

describe('undo and redo put the selection where their step recorded it', () => {
  it('puts the caret after text an undo brings back', () => {
    // "Synthetic undo| text.": backspace over "undo" one character at a time.
    const f = fixture(15);
    for (let at = 15; at > 11; at--) f.view.dispatch(f.view.state.tr.delete(at - 1, at));
    expect(f.text()).toBe(GAP); expect(f.selection()).toEqual({ anchor: 11, head: 11 });
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor: 15, head: 15 });
  });

  it.each([[11, 15], [15, 11]])('selects a deleted range again in its direction, anchor/head %i/%i', (anchor, head) => {
    const f = fixture(anchor, head);
    f.edit(tr => tr.deleteSelection());
    expect(f.selection()).toEqual({ anchor: 11, head: 11 });
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor, head });
  });

  it('returns to the deletion point on redo, and to the range on the undo after it', () => {
    const f = fixture(11, 15);
    f.edit(tr => tr.deleteSelection()); f.undo(); f.redo();
    expect(f.text()).toBe(GAP); expect(f.selection()).toEqual({ anchor: 11, head: 11 });
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor: 11, head: 15 });
  });

  it('leaves the caret after typed text when a redo types it again', () => {
    const f = fixture(15);
    f.edit(tr => tr.insertText(' redo'));
    expect(f.selection()).toEqual({ anchor: 20, head: 20 });
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor: 15, head: 15 });
    f.redo();
    expect(f.text()).toBe('Synthetic undo redo text.'); expect(f.selection()).toEqual({ anchor: 20, head: 20 });
  });

  it('lands each of several undos on its own step', () => {
    const f = fixture(11, 15);
    f.edit(tr => tr.deleteSelection());
    // "second" in the following paragraph, four positions earlier after the first deletion.
    f.view.dispatch(select(21, 27)(f.view.state.tr));
    f.edit(tr => tr.deleteSelection());
    expect(f.view.state.doc.child(1).textContent).toBe('A  synthetic paragraph.');
    f.undo();
    expect(f.view.state.doc.child(1).textContent).toBe(SECOND); expect(f.selection()).toEqual({ anchor: 21, head: 27 });
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor: 11, head: 15 });
  });

  it('keeps the selection from before an edit when a plugin appends to that edit', () => {
    // As the block-id and link-repair plugins do: a follow-up change in the same dispatch.
    const stamp = new Plugin({ appendTransaction: (transactions, _old, state) => {
      if (!transactions.some(tr => tr.docChanged && tr.getMeta(ySyncPluginKey) === undefined)) return null;
      const at = state.doc.child(0).nodeSize; const node = state.doc.nodeAt(at)!;
      return node.attrs.id === 'stamped' ? null : state.tr.setNodeMarkup(at, undefined, { id: 'stamped' });
    } });
    const f = fixture(15, 15, { extraPlugins: [stamp] });
    f.edit(tr => tr.delete(11, 15));
    expect(f.view.state.doc.child(1).attrs.id).toBe('stamped'); expect(f.selection()).toEqual({ anchor: 11, head: 11 });
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor: 15, head: 15 });
  });

  it('follows text another writer put in front of the step', () => {
    const f = fixture(11, 15); const prefix = 'Agent prefix. ';
    f.edit(tr => tr.deleteSelection());
    f.ydoc.transact(() => f.yText().insert(0, prefix), 'agent');
    f.undo();
    expect(f.text()).toBe(prefix + FIRST);
    expect(f.selection()).toEqual({ anchor: 11 + prefix.length, head: 15 + prefix.length });
  });

  it('returns the caret to the start of a paragraph whose join is undone', () => {
    const f = fixture(23);
    f.edit(tr => tr.join(22));
    expect(f.view.state.doc.childCount).toBe(1); expect(f.selection()).toEqual({ anchor: 21, head: 21 });
    f.undo();
    expect(f.view.state.doc.childCount).toBe(2); expect(f.selection()).toEqual({ anchor: 23, head: 23 });
  });

  it('keeps a valid mapped caret when a step recorded no selection', () => {
    const f = fixture(11, 15);
    f.edit(tr => tr.deleteSelection());
    f.manager.undoStack[f.manager.undoStack.length - 1].meta.clear();
    f.undo();
    expect(f.text()).toBe(FIRST); expect(f.selection()).toEqual({ anchor: 11, head: 11 });
  });

  it('reveals the restored selection in a focused editor, and leaves an unfocused one unscrolled', () => {
    for (const focused of [true, false]) {
      const f = fixture(11, 15, { focused });
      f.edit(tr => tr.deleteSelection());
      f.undo();
      expect(f.view.last!.scrolledIntoView).toBe(focused);
    }
  });
});
