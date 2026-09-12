import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, Plugin } from '@tiptap/pm/state';
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

  it.each([true, false])('inherits original history policy %s after another plugin appends a block', (addToHistory) => {
    const schema = getSchema([StarterKit, BlockId] as never);
    const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'existing' }, content: [{ type: 'text', text: 'Synthetic' }] }] });
    const appendBlock = new Plugin({
      appendTransaction(transactions, _oldState, state) {
        if (!transactions.some(tr => tr.getMeta('syntheticAppendBlock'))) return null;
        return state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create());
      },
    });
    // BlockId runs once before this appended block, then sees only the appended
    // transaction. Its history policy must come from the root transaction.
    const state = EditorState.create({ schema, doc, plugins: [createBlockIdPlugin(), appendBlock] });
    const result = state.applyTransaction(state.tr.insertText('!', 2).setMeta('syntheticAppendBlock', true).setMeta('addToHistory', addToHistory));
    expect(result.transactions).toHaveLength(3);
    expect(result.state.doc.lastChild?.attrs.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.transactions[result.transactions.length - 1]?.getMeta('addToHistory')).toBe(addToHistory);
    expect(result.state.doc.firstChild?.attrs.id).toBe('existing');
  });

});
