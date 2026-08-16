import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import { BlockId, createBlockIdPlugin } from './block-id';

describe('BlockId', () => {
  it('assigns one stable id to a block created by a TipTap write', () => {
    const schema = getSchema([StarterKit, BlockId] as never);
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'existing-block' },
          content: [{ type: 'text', text: 'Alpha' }],
        },
      ],
    });
    const initial = EditorState.create({
      schema,
      doc,
      plugins: [createBlockIdPlugin()],
    });
    const insertedParagraph = schema.nodes.paragraph.create(
      undefined,
      schema.text('Beta'),
    );

    const inserted = initial.applyTransaction(
      initial.tr.insert(initial.doc.content.size, insertedParagraph),
    );
    const insertedIds = inserted.state.doc.content.content.map(
      (node) => node.attrs.id as string | null,
    );

    expect(insertedIds[0]).toBe('existing-block');
    expect(insertedIds[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(inserted.transactions).toHaveLength(2);

    const generatedId = insertedIds[1];
    const edited = inserted.state.applyTransaction(
      inserted.state.tr.insertText('!', inserted.state.doc.content.size - 1),
    );
    expect(edited.state.doc.child(1).attrs.id).toBe(generatedId);
    expect(edited.transactions).toHaveLength(1);
  });
});
