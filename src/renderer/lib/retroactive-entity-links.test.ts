import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { linkEntityInDoc } from './retroactive-entity-links';

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {},
}, marks: { entityLink: { attrs: { targetKind: {}, targetId: {}, targetBlockId: { default: null } } }, strong: {} } });
function fixture(text: string, marks = []) {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, text ? schema.text(text, marks) : [])]);
  const transactions: Transaction[] = [];
  const value = { schema, state: EditorState.create({ doc }), view: { dispatch(tr: Transaction) {
    transactions.push(tr); value.state = value.state.apply(tr);
  } } };
  return { value, editor: value as unknown as Editor, transactions };
}
const target = (names: string[], id = 'synthetic') => ({ kind: 'element' as const, id, names });
const ranges = (f: ReturnType<typeof fixture>) => {
  const result: [number, number][] = [];
  f.value.state.doc.descendants((node, pos) => {
    if (node.isText && node.marks.some(mark => mark.type.name === 'entityLink')) result.push([pos - 1, pos - 1 + node.nodeSize]);
  }); return result;
};

describe('retroactive literal entity links', () => {
  it.each([
    ['overlapping aliases', 'abab', ['aba', 'bab'], [[0, 4]]],
    ['non-overlapping repeats per alias', 'aaaaa', ['aa'], [[0, 4]]],
    ['literal regex punctuation', 'x A+B .* [x] y', ['A+B', '.*', '[x]'], [[2, 5], [6, 8], [9, 12]]],
    ['case sensitive', 'alpha ALPHA', ['alpha'], [[0, 5]]],
    ['trim and deduplicate', 'abc abc', [' abc ', '', 'abc', '  '], [[0, 3], [4, 7]]],
    ['UTF-16 offsets', '中😀e\u0301😀', ['😀', 'e\u0301'], [[1, 7]]],
    ['embedded line terminators', 'a\nb\u2028c', ['a\nb', '\u2028c'], [[0, 3], [4, 5]]],
  ] as const)('preserves %s', (_name, text, names, expected) => {
    const f = fixture(text); linkEntityInDoc(f.editor, target([...names]));
    expect(ranges(f)).toEqual(expected); expect(f.value.state.doc.textContent).toBe(text);
    expect(f.transactions).toHaveLength(1); expect(f.transactions[0].getMeta('addToHistory')).toBe(false);
  });

  it('does not join text across formatting boundaries', () => {
    const f = fixture('');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('ab'), schema.text('cd', [schema.marks.strong.create()])])]);
    f.value.state = EditorState.create({ doc }); linkEntityInDoc(f.editor, target(['bc']));
    expect(f.transactions).toHaveLength(0); expect(f.value.state.doc).toBe(doc);
  });
  it('skips same-target runs, preserves formatting and replaces another target', () => {
    const f = fixture('abc');
    const doc = schema.node('doc', null, [schema.node('paragraph', null, schema.text('abc', [schema.marks.strong.create(), schema.marks.entityLink.create({ targetKind: 'node', targetId: 'other' })]))]);
    f.value.state = EditorState.create({ doc }); linkEntityInDoc(f.editor, target(['abc']));
    expect(f.value.state.doc.firstChild!.firstChild!.marks.map(mark => [mark.type.name, mark.attrs.targetId])).toEqual([['entityLink', 'synthetic'], ['strong', undefined]]);
    linkEntityInDoc(f.editor, target(['abc'])); expect(f.transactions).toHaveLength(1);
  });
  it('creates one immutable mark per changed document, none for absent names', () => {
    const create = vi.spyOn(schema.marks.entityLink, 'create');
    try {
      const missing = fixture('aaa'); linkEntityInDoc(missing.editor, target(['missing', ' '])); expect(create).not.toHaveBeenCalled();
      const f = fixture('ab ab ab'); linkEntityInDoc(f.editor, target(['a', 'b'])); expect(create).toHaveBeenCalledTimes(1);
      const next = fixture('ab'); linkEntityInDoc(next.editor, target(['ab'], 'next')); expect(create).toHaveBeenCalledTimes(2);
      expect(next.value.state.doc.firstChild!.firstChild!.marks[0].attrs.targetId).toBe('next');
    } finally { create.mockRestore(); }
  });
  it('does not retain a caller names array or target between calls', () => {
    const names = ['a']; const first = fixture('ab'); linkEntityInDoc(first.editor, target(names));
    names[0] = 'b'; const second = fixture('ab'); linkEntityInDoc(second.editor, target(names));
    expect(ranges(first)).toEqual([[0, 1]]); expect(ranges(second)).toEqual([[1, 2]]);
  });
  it('does not dispatch for empty names or a schema without entity links', () => {
    const f = fixture('a'); linkEntityInDoc(f.editor, target([' ', ''])); expect(f.transactions).toHaveLength(0);
    const noMark = new Schema({ nodes: { doc: { content: 'text*' }, text: {} } });
    linkEntityInDoc({ schema: noMark } as Editor, target(['a']));
  });
});
