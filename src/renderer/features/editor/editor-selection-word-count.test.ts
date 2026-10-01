import type { Editor } from '@tiptap/core';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { AllSelection, EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearIfActive, setActiveEditor } from '../../lib/active-editor';
import { countWordsInPmJson } from '../../lib/word-count';
import { createEditorSelectionWordCountStore } from './editor-selection-word-count';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true },
    image: { group: 'block', atom: true },
  },
  marks: { bold: {} },
});
const paragraph = (text: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const document = (...texts: string[]) => schema.node('doc', null, texts.map(paragraph));

// Real PM selections/documents; only Tiptap's event emitter and focus are doubled.
function fixture(doc: ProseMirrorNode) {
  const callbacks = new Map<string, Set<() => void>>();
  const emitter = {
    isDestroyed: false,
    isFocused: true,
    state: EditorState.create({ doc }),
    on(event: string, fn: () => void) {
      const listeners = callbacks.get(event) ?? new Set();
      listeners.add(fn);
      callbacks.set(event, listeners);
    },
    off(event: string, fn: () => void) { callbacks.get(event)?.delete(fn); },
  };
  const editor = emitter as unknown as Editor;
  const emit = (event: string) => { for (const fn of [...callbacks.get(event) ?? []]) fn(); };
  return {
    editor, emitter, emit,
    select(from: number, to = from) {
      emitter.state = emitter.state.apply(emitter.state.tr.setSelection(TextSelection.create(emitter.state.doc, from, to)));
      emit('selectionUpdate');
    },
    listenerCount: () => [...callbacks.values()].reduce((sum, listeners) => sum + listeners.size, 0),
  };
}

afterEach(() => setActiveEditor(null));

describe('editor selection word count acceptance', () => {
  it('counts partial and reversed mixed CJK/Latin ranges, then restores the total on collapse', () => {
    const f = fixture(document('前文 你好，Drifting world 2.0！ 后文'));
    setActiveEditor(f.editor);
    const store = createEditorSelectionWordCountStore();
    expect(store.getSnapshot()).toBeNull();
    f.select(4, 26);
    expect(store.getSnapshot()).toBe(5);
    f.select(26, 4);
    expect(store.getSnapshot()).toBe(5);
    f.select(4);
    expect(store.getSnapshot()).toBeNull();
  });

  it('preserves paragraph, mark and hard-break boundaries and matches the total on select-all', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hello'), schema.text('world', [schema.mark('bold')]),
        schema.node('hardBreak'), schema.text('again'),
      ]),
      paragraph('你好 next'),
    ]);
    const f = fixture(doc);
    setActiveEditor(f.editor);
    const store = createEditorSelectionWordCountStore();
    f.select(1, doc.content.size - 1);
    expect(store.getSnapshot()).toBe(6);
    f.emitter.state = f.emitter.state.apply(f.emitter.state.tr.setSelection(new AllSelection(doc)));
    expect(store.getSnapshot()).toBe(countWordsInPmJson(JSON.stringify(doc.toJSON())));
  });

  it('shows zero for selected punctuation/whitespace and ignores non-text node selections', () => {
    const f = fixture(schema.node('doc', null, [paragraph(' ，。  '), schema.node('image')]));
    setActiveEditor(f.editor);
    const store = createEditorSelectionWordCountStore();
    f.select(1, 6);
    expect(store.getSnapshot()).toBe(0);
    f.emitter.state = f.emitter.state.apply(f.emitter.state.tr.setSelection(NodeSelection.create(f.emitter.state.doc, 7)));
    expect(store.getSnapshot()).toBeNull();
  });

  it('updates from live document changes, caches unchanged reads, and releases the metric on blur', () => {
    const f = fixture(document('hello world'));
    setActiveEditor(f.editor);
    f.select(1, 12);
    const store = createEditorSelectionWordCountStore();
    const snapshots: (number | null)[] = [];
    const dispose = store.subscribe(() => snapshots.push(store.getSnapshot()));
    const slice = vi.spyOn(f.emitter.state.selection, 'content');
    expect(store.getSnapshot()).toBe(2);
    expect(store.getSnapshot()).toBe(2);
    expect(slice).not.toHaveBeenCalled(); // subscribe already captured this immutable selection

    const doc = document('你好 world');
    f.emitter.state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 9) });
    f.emit('update');
    expect(snapshots[snapshots.length - 1]).toBe(3);
    f.emitter.isFocused = false;
    f.emit('blur');
    expect(snapshots[snapshots.length - 1]).toBeNull();
    f.emitter.isFocused = true;
    f.emit('focus');
    expect(snapshots[snapshots.length - 1]).toBe(3);
    f.select(1);
    expect(snapshots[snapshots.length - 1]).toBeNull();
    dispose();
    expect(f.listenerCount()).toBe(0);
  });

  it('follows tab/split ownership, ignores the old editor, and clears before destruction completes', () => {
    const old = fixture(document('旧章节'));
    const next = fixture(document('next chapter'));
    old.select(1, 4);
    next.select(1, 5);
    setActiveEditor(old.editor);
    const store = createEditorSelectionWordCountStore();
    const snapshots: (number | null)[] = [];
    const dispose = store.subscribe(() => snapshots.push(store.getSnapshot()));
    expect(snapshots[snapshots.length - 1]).toBe(3);
    setActiveEditor(next.editor);
    expect(snapshots[snapshots.length - 1]).toBe(1);
    expect(old.listenerCount()).toBe(0);
    const events = snapshots.length;
    old.select(1);
    clearIfActive(old.editor);
    expect(snapshots).toHaveLength(events);
    next.emit('destroy'); // Tiptap destroys its view after this event.
    expect(snapshots[snapshots.length - 1]).toBeNull();
    expect(next.listenerCount()).toBe(0);
    dispose();
    setActiveEditor(old.editor);
    expect(old.listenerCount()).toBe(0);
  });
});
