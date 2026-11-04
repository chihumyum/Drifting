import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { AutoDetectTarget } from '../extensions/entity-link';
import { relinkYjsBlocks } from './yjs-entity-relink';

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
});
