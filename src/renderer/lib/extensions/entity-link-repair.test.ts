import { describe, expect, it } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';

import { EntityLink } from './entity-link';
import {
  createEntityLinkRepairPlugin,
  ENTITY_LINK_REPAIR_META,
  pendingEditedLinkRuns,
  repairEditedLinks,
  type IsLinkName,
} from './entity-link-repair';

const schema = getSchema([StarterKit, EntityLink.configure({ composeInsideLink: false })]);
const markType = schema.marks.entityLink;

const link = (text: string, targetId = 'yuege'): JSONContent => ({
  type: 'text',
  text,
  marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId } }],
});
const plain = (text: string): JSONContent => ({ type: 'text', text });

/** 约格 and its alias 约格斯 belong to one element; 米契 to another. */
const names = new Map([
  ['约格', 'yuege'],
  ['约格斯', 'yuege'],
  ['米契', 'miqi'],
]);
const isName: IsLinkName = (text, mark) => names.get(text) === mark.attrs.targetId;

function setup(content: JSONContent[]) {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content }] });
  return EditorState.create({
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [createEntityLinkRepairPlugin(markType, isName)],
  });
}

/** Text runs of the first paragraph with the link targets on each. */
function runs(state: EditorState): Array<[string, string[]]> {
  const result: Array<[string, string[]]> = [];
  state.doc.firstChild!.forEach((child) => {
    result.push([child.text ?? '', child.marks.filter((mark) => mark.type === markType).map((mark) => mark.attrs.targetId)]);
  });
  return result;
}

describe('entity-link repair after edits', () => {
  it('unlinks what remains of a name an edit broke, in the same step', () => {
    const state = setup([plain('打碎了'), link('约格'), plain('的头')]);
    // Positions: paragraph content starts at 1; 约格 occupies 4–6.
    const next = state.apply(state.tr.delete(5, 6));

    expect(runs(next)).toEqual([['打碎了约的头', []]]);
    expect(pendingEditedLinkRuns(next)).toEqual([]);
  });

  it('keeps a link edited into another name of its target', () => {
    const state = setup([link('约格斯'), plain('来了')]);
    const next = state.apply(state.tr.delete(3, 4));

    expect(runs(next)).toEqual([['约格', ['yuege']], ['来了', []]]);
  });

  it('leaves links on text that was not a name alone', () => {
    const state = setup([link('那个人'), plain('来了')]);
    const next = state.apply(state.tr.delete(3, 4));

    expect(runs(next)).toEqual([['那个', ['yuege']], ['来了', []]]);
  });

  it('ignores remote Yjs changes, including undo', () => {
    const state = setup([link('约格'), plain('的头')]);
    const next = state.apply(state.tr.delete(2, 3).setMeta(ySyncPluginKey, { isChangeOrigin: true }));

    expect(runs(next)).toEqual([['约', ['yuege']], ['的头', []]]);
    expect(pendingEditedLinkRuns(next)).toEqual([]);
  });

  it('waits while a composition is open and repairs with the next edit', () => {
    const state = setup([link('约格'), plain('的头')]);
    const composing = state.apply(state.tr.insertText('想', 2).setMeta('composition', 1));
    expect(runs(composing)).toEqual([['约想格', ['yuege']], ['的头', []]]);
    expect(pendingEditedLinkRuns(composing)).toHaveLength(1);

    const next = composing.apply(composing.tr.insertText('。', composing.doc.content.size - 1));
    expect(runs(next)).toEqual([['约想格的头。', []]]);
  });

  it('repairs pending runs for the debounced pass and clears them', () => {
    const state = setup([link('约格'), plain('的头')]);
    const composing = state.apply(state.tr.delete(2, 3).setMeta('composition', 1));
    const tr = composing.tr.setMeta(ENTITY_LINK_REPAIR_META, true);

    expect(repairEditedLinks(tr, pendingEditedLinkRuns(composing), isName)).toBe(true);
    const next = composing.apply(tr);
    expect(runs(next)).toEqual([['约的头', []]]);
    expect(pendingEditedLinkRuns(next)).toEqual([]);
  });

  it('repairs each of nested links on its own', () => {
    const outer = { type: 'entityLink', attrs: { targetKind: 'element', targetId: 'miqi' } };
    const state = setup([
      { type: 'text', text: '被', marks: [outer] },
      { type: 'text', text: '约格', marks: [outer, { type: 'entityLink', attrs: { targetKind: 'element', targetId: 'yuege' } }] },
      { type: 'text', text: '米契', marks: [outer] },
    ]);
    const next = state.apply(state.tr.delete(3, 4));

    expect(runs(next)).toEqual([['被约米契', ['miqi']]]);
  });

  it('records nothing for typing beside a link', () => {
    const state = setup([link('约格'), plain('的头')]);
    const next = state.apply(state.tr.insertText('看', 3));

    expect(pendingEditedLinkRuns(next)).toEqual([]);
    expect(runs(next)).toEqual([['约格', ['yuege']], ['看的头', []]]);
  });

  it('does not treat mark-only changes as edits', () => {
    const state = setup([plain('约格的头')]);
    const linked = state.apply(state.tr.addMark(1, 3, markType.create({ targetKind: 'element', targetId: 'yuege' })));

    expect(pendingEditedLinkRuns(linked)).toEqual([]);
    expect(runs(linked)).toEqual([['约格', ['yuege']], ['的头', []]]);
  });
});
