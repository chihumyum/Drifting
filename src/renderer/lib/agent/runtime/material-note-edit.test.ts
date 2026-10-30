import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { noteBlockMarkdown } from '../../note-markdown';
import { parseNoteMarkdown } from '../../note-markdown-parse';
import { noteBlocksOperation, planNoteRevision, type NoteMarkdownCodec } from './material-note-edit';
import type { YjsProseBlock } from './yjs-prose-command';

function codec(): NoteMarkdownCodec {
  let next = 0;
  return {
    render: (nodes) => noteBlockMarkdown(nodes),
    parse: (markdown) => parseNoteMarkdown(markdown, { nextId: () => `new-${++next}` }),
  };
}

const paragraph = (id: string, text: string): JSONContent => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});

const block = (node: JSONContent): YjsProseBlock => ({ id: String(node.attrs?.id), type: node.type! });

describe('planNoteRevision', () => {
  const nodes = [paragraph('a', '潮汐表来自港务局。'), paragraph('b', '灯塔停用于 1937 年。'), paragraph('c', '待查。')];

  it('re-parses only the block a passage touches', () => {
    const plan = planNoteRevision(nodes, [{ currentText: '1937', revisedText: '1938' }], codec());
    expect(plan.replacements).toBe(1);
    expect(plan.blocks.map((entry) => entry.kind)).toEqual(['kept', 'new', 'kept']);
    expect(plan.blocks[1]!.node.content).toEqual([{ type: 'text', text: '灯塔停用于 1938 年。' }]);
  });

  it('merges blocks when a passage spans a blank line', () => {
    const plan = planNoteRevision(
      nodes,
      [{ currentText: '港务局。\n\n灯塔', revisedText: '港务局，灯塔' }],
      codec(),
    );
    expect(plan.blocks.map((entry) => entry.kind)).toEqual(['new', 'kept']);
  });

  it('rejects missing and ambiguous passages', () => {
    expect(() => planNoteRevision(nodes, [{ currentText: '不存在', revisedText: 'x' }], codec())).toThrow(/不在当前笔记/);
    expect(() => planNoteRevision(nodes, [{ currentText: '。', revisedText: '！' }], codec())).toThrow(/出现了 3 次/);
    const all = planNoteRevision(nodes, [{ currentText: '。', revisedText: '！', allOccurrences: true }], codec());
    expect(all.replacements).toBe(3);
  });

  it('keeps TODO links on unchanged checklist lines', () => {
    const list: JSONContent = {
      type: 'taskList',
      attrs: { id: 'list' },
      content: [
        { type: 'taskItem', attrs: { id: 't1', checked: false, todoId: 'todo-1' }, content: [paragraph('p1', '找潮汐表')] },
        { type: 'taskItem', attrs: { id: 't2', checked: false, todoId: 'todo-2' }, content: [paragraph('p2', '查年代')] },
      ],
    };
    const plan = planNoteRevision([list], [{ currentText: '查年代', revisedText: '查灯塔年代' }], codec());
    const items = plan.blocks[0]!.node.content!;
    expect(items[0]!.attrs?.todoId).toBe('todo-1');
    expect(items[1]!.attrs?.todoId).toBeUndefined();
  });
});

describe('noteBlocksOperation', () => {
  const base = ['a', 'b', 'c'].map((id) => block(paragraph(id, id)));

  it('edits in place and keeps the top-level id when the block count holds', () => {
    const operation = noteBlocksOperation(
      base,
      [{ kind: 'kept', index: 0, node: {} }, { kind: 'new', node: {} }, { kind: 'kept', index: 2, node: {} }],
      [{ id: 'fresh', type: 'paragraph' }],
    );
    expect(operation).toEqual({ kind: 'edit', blockId: 'b', block: { id: 'b', type: 'paragraph' } });
  });

  it('replaces the smallest covering range when blocks are added or removed', () => {
    expect(
      noteBlocksOperation(base, [{ kind: 'kept', index: 0, node: {} }, { kind: 'new', node: {} }], [{ id: 'x', type: 'paragraph' }]),
    ).toEqual({ kind: 'replace', fromBlockId: 'b', toBlockId: 'c', blocks: [{ id: 'x', type: 'paragraph' }] });
    expect(
      noteBlocksOperation(base, [{ kind: 'kept', index: 0, node: {} }, { kind: 'kept', index: 2, node: {} }], []),
    ).toEqual({ kind: 'remove', blockIds: ['b'] });
  });

  it('returns null when nothing changed', () => {
    expect(
      noteBlocksOperation(base, base.map((_, index) => ({ kind: 'kept' as const, index, node: {} })), []),
    ).toBeNull();
  });
});
