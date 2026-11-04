import { describe, expect, it } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EditorState } from '@tiptap/pm/state';

import { EntityLink } from './entity-link';
import { forEachNameRun, linkRegisteredNames } from './entity-link-name-runs';

const schema = getSchema([StarterKit, EntityLink.configure({ composeInsideLink: false })]);
const linkType = schema.marks.entityLink;

const link = (text: string, targetId: string, targetBlockId: string | null = null): JSONContent => ({
  type: 'text',
  text,
  marks: [{ type: 'entityLink', attrs: { targetKind: 'element', targetId, targetBlockId } }],
});
const plain = (text: string): JSONContent => ({ type: 'text', text });
const bold = (text: string): JSONContent => ({ type: 'text', text, marks: [{ type: 'bold' }] });

/** 安娜蒂 and her alias 安纳蒂 are one element; 米契 another. */
const targets = new Map([
  ['安娜蒂', { kind: 'element', id: 'annati' }],
  ['安纳蒂', { kind: 'element', id: 'annati' }],
  ['米契', { kind: 'element', id: 'mitch' }],
]);
const matcher = /安娜蒂|安纳蒂|米契/g;

function state(...paragraphs: JSONContent[][]) {
  return EditorState.create({
    doc: schema.nodeFromJSON({ type: 'doc', content: paragraphs.map((content) => ({ type: 'paragraph', content })) }),
  });
}

/** Text runs of each paragraph with the link targets on each. */
function runs(current: EditorState): Array<Array<[string, string[]]>> {
  const result: Array<Array<[string, string[]]>> = [];
  current.doc.forEach((paragraph) => {
    const row: Array<[string, string[]]> = [];
    paragraph.forEach((child) => {
      row.push([child.text ?? '', child.marks.filter((mark) => mark.type === linkType).map((mark) => mark.attrs.targetId)]);
    });
    result.push(row);
  });
  return result;
}

function autoLink(current: EditorState): { next: EditorState; modified: boolean } {
  const tr = current.tr;
  const modified = linkRegisteredNames(tr, linkType, matcher, targets);
  return { next: current.apply(tr), modified };
}

describe('auto-linking names across link boundaries', () => {
  it('links a name an edit left partly linked as one link again', () => {
    const { next, modified } = autoLink(state([link('安', 'annati'), plain('纳'), link('蒂', 'annati'), plain('对'), link('米契', 'mitch'), plain('说。')]));

    expect(modified).toBe(true);
    expect(runs(next)).toEqual([[['安纳蒂', ['annati']], ['对', []], ['米契', ['mitch']], ['说。', []]]]);
  });

  it('completes a link with the link already there, so a deep link stays one link', () => {
    const { next } = autoLink(state([link('安', 'annati', 'block-1'), plain('纳蒂')]));

    const marks = next.doc.firstChild!.firstChild!.marks;
    expect(next.doc.firstChild!.childCount).toBe(1);
    expect(marks.map((mark) => mark.attrs.targetBlockId)).toEqual(['block-1']);
  });

  it('links a plain name and leaves a wholly linked one alone', () => {
    const { next, modified } = autoLink(state([plain('安纳蒂来了')], [link('米契', 'mitch'), plain('走了')]));

    expect(modified).toBe(true);
    expect(runs(next)).toEqual([[['安纳蒂', ['annati']], ['来了', []]], [['米契', ['mitch']], ['走了', []]]]);
    expect(autoLink(next).modified).toBe(false);
  });

  it('does not read a name across other formatting', () => {
    const { modified } = autoLink(state([plain('安纳'), bold('蒂')]));

    expect(modified).toBe(false);
  });

  it('does not join names across paragraphs or hard breaks', () => {
    const texts: string[] = [];
    forEachNameRun(
      state([plain('安纳'), { type: 'hardBreak' }, plain('蒂')], [plain('米'), link('契', 'mitch')]).doc,
      linkType,
      (run) => texts.push(run.text),
    );

    expect(texts).toEqual(['安纳', '蒂', '米契']);
  });
});
