import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LeafTab } from '../store/ui-store';
import { captureEditorSelectionSnapshot, editorTabSelectionKey, getEditorSelectionSnapshot, hasEditorSelectionSnapshot,
  pruneEditorSelectionMemory, restoreEditorSelectionSnapshot, saveEditorSelectionSnapshot } from './editor-selection-memory';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', attrs: { id: { default: null } } }, text: { group: 'inline' },
} });
function paragraph(id: string, text: string) { return schema.node('paragraph', { id }, text ? [schema.text(text)] : []); }
function fixture(text = 'Synthetic selection memory prose.', anchor = 8, head = 3) {
  const doc = schema.node('doc', null, [paragraph('b', text)]);
  const transactions: Transaction[] = [];
  const value = { isDestroyed: false, state: EditorState.create({ doc, selection: TextSelection.create(doc, anchor, head) }),
    view: { dispatch(tr: Transaction) { transactions.push(tr); value.state = value.state.apply(tr); }, focus: vi.fn() }, commands: { focus: vi.fn() } };
  return { value, editor: value as unknown as Editor, transactions };
}
afterEach(() => { pruneEditorSelectionMemory('p', []); pruneEditorSelectionMemory('q', []); vi.restoreAllMocks(); });

describe('position-only editor selection memory', () => {
  it('keeps a backward text range without retaining prose or document objects', () => {
    const f = fixture();
    expect(captureEditorSelectionSnapshot(f.editor, false)).toEqual({ anchor: 8, head: 3, focusOnRestore: false });
  });

  it.each([5000, 20000, 50000])('does no document traversal or text extraction for %i characters and 200 caret moves', characters => {
    const blocks = Array.from({ length: characters / 100 }, (_, index) => paragraph(String(index), '合成'.repeat(50)));
    const doc = schema.node('doc', null, blocks);
    const descendants = vi.spyOn(doc, 'descendants').mockImplementation(() => { throw new Error('Selection memory scanned prose'); });
    const text = vi.spyOn(doc, 'textBetween').mockImplementation(() => { throw new Error('Selection memory copied prose'); });
    for (let i = 0; i < 200; i++) {
      const position = (i % blocks.length) * 102 + 1 + (i % 80);
      const state = EditorState.create({ doc, selection: TextSelection.create(doc, position, position + 1) });
      expect(captureEditorSelectionSnapshot({ state } as Editor)).toEqual({ anchor: position, head: position + 1, focusOnRestore: true });
    }
    expect(descendants).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
  });

  it('reuses snapshots for duplicate update/selection/blur captures and updates direction or preference', () => {
    const f = fixture(); const key = 'p:node:n';
    saveEditorSelectionSnapshot(key, f.editor); const before = getEditorSelectionSnapshot(key);
    for (let i = 0; i < 20; i++) saveEditorSelectionSnapshot(key, f.editor);
    expect(getEditorSelectionSnapshot(key)).toBe(before);
    f.value.state = f.value.state.apply(f.value.state.tr.setSelection(TextSelection.create(f.value.state.doc, 3, 8)));
    saveEditorSelectionSnapshot(key, f.editor); expect(getEditorSelectionSnapshot(key)).toMatchObject({ anchor: 3, head: 8 });
    saveEditorSelectionSnapshot(key, f.editor, false); expect(getEditorSelectionSnapshot(key)?.focusOnRestore).toBe(false);
  });

  it('restores a backward range without history, scroll, focus, or an unowned frame', () => {
    const f = fixture(); saveEditorSelectionSnapshot('p:node:n', f.editor);
    const restored = fixture('Synthetic selection memory prose.', 1, 1);
    expect(restoreEditorSelectionSnapshot('p:node:n', restored.editor)).toBe(true);
    expect(restored.value.state.selection.toJSON()).toEqual({ type: 'text', anchor: 8, head: 3 });
    expect(restored.transactions[0].getMeta('addToHistory')).toBe(false);
    expect(restored.transactions[0].scrolledIntoView).toBe(false);
    expect(restored.value.view.focus).not.toHaveBeenCalled(); expect(restored.value.commands.focus).not.toHaveBeenCalled();
  });

  it('clamps stale offsets into shorter/empty documents and returns false on dispatch failure', () => {
    saveEditorSelectionSnapshot('p:node:n', fixture().editor);
    const short = fixture('ab', 1, 1); expect(restoreEditorSelectionSnapshot('p:node:n', short.editor)).toBe(true);
    expect(short.value.state.selection.from).toBe(3); expect(short.value.state.selection.to).toBe(3);
    const empty = fixture('', 1, 1); expect(restoreEditorSelectionSnapshot('p:node:n', empty.editor)).toBe(true);
    expect(empty.value.state.selection.from).toBe(1);
    short.value.view.dispatch = () => { throw new Error('retired view'); };
    expect(restoreEditorSelectionSnapshot('p:node:n', short.editor)).toBe(false);
  });

  it('ignores absent keys and destroyed editors', () => {
    const f = fixture(); f.value.isDestroyed = true;
    saveEditorSelectionSnapshot('p:node:n', f.editor); saveEditorSelectionSnapshot(null, f.editor);
    expect(hasEditorSelectionSnapshot('p:node:n')).toBe(false); expect(getEditorSelectionSnapshot(null)).toBe(null);
    expect(restoreEditorSelectionSnapshot('p:node:n', f.editor)).toBe(false);
  });

  it('prunes closed leaves while retaining both split sides and other projects', () => {
    const leaf = (id: string): LeafTab => ({ kind: 'leaf', entityType: 'node', id, isPreview: false });
    for (const id of ['left', 'right', 'closed']) saveEditorSelectionSnapshot(editorTabSelectionKey('p', leaf(id)), fixture().editor);
    saveEditorSelectionSnapshot(editorTabSelectionKey('q', leaf('left')), fixture().editor);
    pruneEditorSelectionMemory('p', [{ kind: 'split', id: 'split', left: leaf('left'), right: leaf('right'), focused: 'right', splitRatio: 0.5 }]);
    expect(hasEditorSelectionSnapshot('p:node:left')).toBe(true); expect(hasEditorSelectionSnapshot('p:node:right')).toBe(true);
    expect(hasEditorSelectionSnapshot('p:node:closed')).toBe(false); expect(hasEditorSelectionSnapshot('q:node:left')).toBe(true);
    pruneEditorSelectionMemory('p', [leaf('right')]); expect(hasEditorSelectionSnapshot('p:node:left')).toBe(false);
  });
});
