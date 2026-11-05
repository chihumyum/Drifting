import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { AutoDetectTarget } from '../extensions/entity-link';
import type { YjsProseBlock, YjsProseNode } from './runtime/yjs-prose-command';
import { linkNamesInProseBlocks, linkNamesInProseOperation, relinkYjsBlocks } from './yjs-entity-relink';

const annati = { entityLink: { targetKind: 'element', targetId: 'annati', targetBlockId: null } };
const hashedAnnati = { 'entityLink--abcdefgh': annati.entityLink };
const mitch = { 'entityLink--ijklmnop': { targetKind: 'element', targetId: 'mitch', targetBlockId: null } };

const config = {
  autoDetectEnabled: true,
  autoDetectTargets: new Map<string, AutoDetectTarget>([
    ['安娜蒂', { kind: 'element', id: 'annati' }],
    ['安纳蒂', { kind: 'element', id: 'annati' }],
    ['米契', { kind: 'element', id: 'mitch' }],
  ]),
};

type Run = [string, Record<string, unknown>?];

/** A paragraph `p1` with one Y.XmlText per entry of `children`, each made of formatted runs. */
function paragraph(...children: Run[][]): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const element = new Y.XmlElement('paragraph');
  element.setAttribute('id', 'p1');
  fragment.insert(0, [element]);
  element.insert(0, children.map(() => new Y.XmlText()));
  children.forEach((runs, index) => {
    const text = element.get(index) as Y.XmlText;
    let offset = 0;
    for (const [insert, attributes] of runs) {
      text.insert(offset, insert, attributes ?? {});
      offset += insert.length;
    }
  });
  return { doc, fragment };
}

/** The paragraph's text runs across its children, with their link targets. */
function links(fragment: Y.XmlFragment): Array<[string, string[]]> {
  const element = fragment.get(0) as Y.XmlElement;
  const result: Array<[string, string[]]> = [];
  for (const child of element.toArray()) {
    for (const delta of (child as Y.XmlText).toDelta() as Array<{ insert: string; attributes?: Record<string, { targetId: string }> }>) {
      const targets = Object.entries(delta.attributes ?? {})
        .filter(([key]) => key.startsWith('entityLink'))
        .map(([key, value]) => `${key}:${value.targetId}`);
      const last = result[result.length - 1];
      if (last && JSON.stringify(last[1]) === JSON.stringify(targets)) last[0] += delta.insert;
      else result.push([delta.insert, targets]);
    }
  }
  return result;
}

describe('relinking names in written prose', () => {
  it('links a name split across text children and links as one link, with the link already there', () => {
    const { fragment } = paragraph(
      [['安', hashedAnnati]], [['纳']], [['蒂', hashedAnnati]], [['对']], [['米契', mitch]], [['说。']],
    );
    relinkYjsBlocks(fragment, ['p1'], config);

    expect(links(fragment)).toEqual([
      ['安纳蒂', ['entityLink--abcdefgh:annati']],
      ['对', []],
      ['米契', ['entityLink--ijklmnop:mitch']],
      ['说。', []],
    ]);
  });

  it('finds names at their real offsets in text that already carries links', () => {
    const { fragment } = paragraph([['米契', mitch], ['看着安纳蒂。']]);
    relinkYjsBlocks(fragment, ['p1'], config);

    expect(links(fragment)).toEqual([
      ['米契', ['entityLink--ijklmnop:mitch']],
      ['看着', []],
      ['安纳蒂', ['entityLink:annati']],
      ['。', []],
    ]);
  });

  it('leaves linked names alone and reads no name across other formatting', () => {
    const { doc, fragment } = paragraph([['安纳蒂', annati], ['与安纳'], ['蒂', { bold: {} }]]);
    let updates = 0;
    doc.on('update', () => { updates += 1; });
    relinkYjsBlocks(fragment, ['p1'], config);

    expect(updates).toBe(0);
  });

  it('touches only the blocks it is given', () => {
    const { fragment } = paragraph([['安纳蒂']]);
    relinkYjsBlocks(fragment, ['other'], config);

    expect(links(fragment)).toEqual([['安纳蒂', []]]);
  });

  it('links only the given targets across every block, still letting a longer name win', () => {
    const withShortName = {
      autoDetectEnabled: true,
      autoDetectTargets: new Map<string, AutoDetectTarget>([...config.autoDetectTargets, ['安', { kind: 'element', id: 'an' }]]),
    };
    const { fragment } = paragraph([['安纳蒂对米契说：安心。']]);
    relinkYjsBlocks(fragment, 'all', withShortName, [{ kind: 'element', id: 'an' }]);

    expect(links(fragment)).toEqual([['安纳蒂对米契说：', []], ['安', ['entityLink:an']], ['心。', []]]);
  });
});

describe('linking names in what the Agent writes', () => {
  const block = (id: string, ...content: YjsProseNode[]): YjsProseBlock => ({ id, type: 'paragraph', content: [...content] });
  const text = (value: string, marks?: Record<string, unknown>): YjsProseNode =>
    ({ kind: 'text', text: value, ...(marks ? { marks: marks as never } : {}) });
  /** A block's text runs with the targets each links to, adjacent runs alike joined. */
  const linked = (written: YjsProseBlock) => {
    const result: Array<[string, string[]]> = [];
    for (const node of written.content ?? []) {
      if (node.kind !== 'text') continue;
      const targets = Object.values(node.marks ?? {}).flatMap((mark) => (mark as { targetId?: string }).targetId ?? []);
      const last = result[result.length - 1];
      if (last && JSON.stringify(last[1]) === JSON.stringify(targets)) last[0] += node.text;
      else result.push([node.text, targets]);
    }
    return result;
  };

  it('links the names in new paragraphs and keeps their ids', () => {
    const operation = linkNamesInProseOperation(
      { kind: 'insert', afterBlockId: null, blocks: [block('a', text('安纳蒂对米契说。')), block('b', text('无名'))] },
      config,
    );

    expect(operation.kind).toBe('insert');
    const blocks = operation.kind === 'insert' ? operation.blocks : [];
    expect(blocks.map((written) => written.id)).toEqual(['a', 'b']);
    expect(linked(blocks[0]!)).toEqual([['安纳蒂', ['annati']], ['对', []], ['米契', ['mitch']], ['说。', []]]);
    expect(linked(blocks[1]!)).toEqual([['无名', []]]);
  });

  it('links an edited paragraph and mends a name it left partly linked', () => {
    const operation = linkNamesInProseOperation(
      { kind: 'edit', blockId: 'a', block: block('a', text('安', annati), text('纳蒂与米契')) },
      config,
    );

    expect(operation.kind === 'edit' && operation.blockId).toBe('a');
    expect(operation.kind === 'edit' && linked(operation.block)).toEqual([['安纳蒂', ['annati']], ['与', []], ['米契', ['mitch']]]);
  });

  it('links each paragraph of a multi-paragraph edit in place', () => {
    const operation = linkNamesInProseOperation(
      { kind: 'edit_many', edits: [
        { blockId: 'a', block: block('a', text('米契')) },
        { blockId: 'c', block: block('c', text('没人')) },
      ] },
      config,
    );

    expect(operation.kind === 'edit_many' && operation.edits.map((edit) => [edit.blockId, linked(edit.block)])).toEqual([
      ['a', [['米契', ['mitch']]]],
      ['c', [['没人', []]]],
    ]);
  });

  it('writes the blocks as planned while automatic element links are off', () => {
    const blocks = [block('a', text('安纳蒂'))];

    expect(linkNamesInProseBlocks(blocks, { autoDetectEnabled: false, autoDetectTargets: config.autoDetectTargets })).toBe(blocks);
    expect(linkNamesInProseOperation({ kind: 'remove', blockIds: ['a'] }, config)).toEqual({ kind: 'remove', blockIds: ['a'] });
  });
});
