import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/core';

import { EntityLink } from './entity-link';
import {
  ENTITY_LINK_COMPOSITION_META,
  linkCompositionAt,
  overrideMarkInclusive,
  stripLinkComposition,
  type LinkComposition,
} from './entity-link-composition';

const link = (text: string, targetId = 'synthetic-person', extra: JSONContent['marks'] = []): JSONContent => ({
  type: 'text',
  text,
  marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId } }, ...extra],
});
const plain = (text: string): JSONContent => ({ type: 'text', text });
const createSchema = () => getSchema([StarterKit, EntityLink.configure({ composeInsideLink: false })]);

function setup(content: JSONContent[], caret: number, schema = createSchema()) {
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content }] });
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) });
  return { schema, state, markType: schema.marks.entityLink };
}

/** Text runs of the first paragraph with whether each is linked. */
function runs(state: EditorState): Array<[string, boolean]> {
  const result: Array<[string, boolean]> = [];
  state.doc.firstChild!.forEach((child) => {
    result.push([child.text ?? '', child.marks.some((mark) => mark.type.name === 'entityLink')]);
  });
  return result;
}

describe('composition at the edge of an entity link', () => {
  it('opens only where ProseMirror would compose in its cursor wrapper', () => {
    // Positions: 1 is the paragraph start; 远山 occupies 1–3.
    const following = setup([plain('前'), link('远山'), plain('正文')], 4);
    expect(linkCompositionAt(following.state, following.markType)).toMatchObject({ linkText: '远山', strip: true });

    const atParagraphEnd = setup([plain('前'), link('远山')], 4);
    expect(linkCompositionAt(atParagraphEnd.state, atParagraphEnd.markType)).toMatchObject({ strip: true });

    const inside = setup([link('远山'), plain('正文')], 2);
    expect(linkCompositionAt(inside.state, inside.markType)).toBeNull();

    const afterPlain = setup([link('远山'), plain('正文')], 5);
    expect(linkCompositionAt(afterPlain.state, afterPlain.markType)).toBeNull();

    const stored = setup([link('远山'), plain('正文')], 3);
    const withStoredMarks = stored.state.apply(stored.state.tr.setStoredMarks([stored.schema.marks.bold.create()]));
    expect(linkCompositionAt(withStoredMarks, stored.markType)).toBeNull();
  });

  it('opens at a link with no text before it on the line', () => {
    const atStart = setup([link('米契'), plain('突然')], 1);
    expect(linkCompositionAt(atStart.state, atStart.markType)).toMatchObject({ side: 'start', linkText: '米契', strip: true });

    const afterBreak = setup([plain('前'), { type: 'hardBreak' }, link('米契')], 3);
    expect(linkCompositionAt(afterBreak.state, afterBreak.markType)).toMatchObject({ side: 'start', linkText: '米契' });

    // WebKit composes at the end of the preceding text instead.
    const afterText = setup([plain('前'), link('米契')], 2);
    expect(linkCompositionAt(afterText.state, afterText.markType)).toBeNull();
  });

  it('moves text composed before a line-start link out of it', () => {
    const before = setup([link('米契'), plain('突然')], 1);
    const composition = linkCompositionAt(before.state, before.markType)!;
    const { state } = setup([link('被约格米契'), plain('突然')], 4, before.schema);

    expect(runs(state.apply(stripLinkComposition(state, composition)!))).toEqual([
      ['被约格', false],
      ['米契', true],
      ['突然', false],
    ]);
    const renamed = setup([link('被米'), plain('突然')], 2, before.schema);
    expect(stripLinkComposition(renamed.state, composition)).toBeNull();
  });

  it('keeps text composed between two parts of one link inside it', () => {
    const { state, markType, schema } = setup([link('远'), link('山', 'synthetic-person', [{ type: 'bold' }])], 2);
    expect(schema.marks.bold).toBeDefined();
    expect(linkCompositionAt(state, markType)).toMatchObject({ linkText: '远', strip: false });
  });

  it('lets ProseMirror treat the link as inclusive only while the window is open', () => {
    const { state, markType } = setup([link('远山'), plain('正文')], 3);
    let open = false;
    overrideMarkInclusive(markType, () => open);

    const typed = (current: EditorState) => current.apply(current.tr.insertText('想', 3));
    expect(runs(typed(state))).toEqual([['远山', true], ['想正文', false]]);
    open = true;
    expect(state.selection.$from.marks().some((mark) => mark.type === markType)).toBe(true);
    expect(runs(typed(state))).toEqual([['远山想', true], ['正文', false]]);
    open = false;
    expect(markType.spec.inclusive).toBe(false);
  });

  it('moves composed text out of the link and leaves the link text as it was', () => {
    const before = setup([plain('前'), link('远山'), plain('正文')], 4);
    const composition = linkCompositionAt(before.state, before.markType)!;
    const { state } = setup([plain('前'), link('远山想'), plain('正文')], 5, before.schema);

    const tr = stripLinkComposition(state, composition)!;
    expect(tr.getMeta(ENTITY_LINK_COMPOSITION_META)).toBe(true);
    expect(runs(state.apply(tr))).toEqual([['前', false], ['远山', true], ['想正文', false]]);
  });

  it('strips text around a caret placed inside paired punctuation', () => {
    const { state, markType } = setup([link('远山“”')], 4);
    const composition: LinkComposition = {
      mark: markType.create({ targetKind: 'element', targetId: 'synthetic-person' }),
      side: 'end',
      linkText: '远山',
      strip: true,
    };
    expect(runs(state.apply(stripLinkComposition(state, composition)!))).toEqual([['远山', true], ['“”', false]]);
  });

  it('changes nothing when the composition was cancelled, kept inside, or the run is not the link', () => {
    const schema = createSchema();
    const mark = schema.marks.entityLink.create({ targetKind: 'element', targetId: 'synthetic-person' });
    const composition: LinkComposition = { mark, side: 'end', linkText: '远山', strip: true };

    const cancelled = setup([link('远山'), plain('正文')], 3, schema);
    expect(stripLinkComposition(cancelled.state, composition)).toBeNull();

    const between = setup([link('远山想')], 4, schema);
    expect(stripLinkComposition(between.state, { ...composition, strip: false })).toBeNull();

    const otherRun = setup([link('别处想')], 4, schema);
    expect(stripLinkComposition(otherRun.state, composition)).toBeNull();

    const caretElsewhere = setup([link('远山想'), plain('正文')], 6, schema);
    expect(stripLinkComposition(caretElsewhere.state, composition)).toBeNull();
  });
});
