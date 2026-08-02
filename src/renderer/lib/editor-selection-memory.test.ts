import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import { captureEditorSelectionSnapshot } from './editor-selection-memory';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      attrs: { id: { default: null } },
    },
    text: { group: 'inline' },
  },
});

function paragraph(id: string, text: string) {
  return schema.node('paragraph', { id }, text ? [schema.text(text)] : []);
}

describe('editor selection memory', () => {
  it('captures an exact span, stable block identity, and nearby voice context', () => {
    const first = paragraph('block-1', '前一段是作者的语气证据。');
    const second = paragraph('block-2', '只选择这一句话进行润色。');
    const third = paragraph('block-3', '后一段继续保持叙事节奏。');
    const doc = schema.node('doc', null, [first, second, third]);
    const textStart = first.nodeSize + 1;
    const from = textStart + 3;
    const to = from + 4;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, to),
    });
    const snapshot = captureEditorSelectionSnapshot({ state } as Editor);

    expect(snapshot).toMatchObject({
      version: 3,
      mode: 'selection',
      selectedText: '这一句话',
      selectedBlocks: [
        {
          id: 'block-2',
          ordinal: 2,
          text: '只选择这一句话进行润色。',
        },
      ],
      contextBefore: ['前一段是作者的语气证据。'],
      contextAfter: ['后一段继续保持叙事节奏。'],
    });
  });
});
