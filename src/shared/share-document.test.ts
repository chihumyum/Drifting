import { describe, expect, it } from 'vitest';
import { schemaForProfile } from '../renderer/lib/editor-schema-profile';
import { proseJsonToShareDocument, shareBlockText } from './share-document';

const prose = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: 'h', level: 2, textAlign: 'center' }, content: [{ type: 'text', text: '第一节' }] },
    {
      type: 'paragraph',
      attrs: { id: 'p', indent: 2 },
      content: [
        { type: 'text', text: '她', marks: [{ type: 'bold' }] },
        { type: 'text', text: '推开', marks: [{ type: 'bold' }, { type: 'entityLink', attrs: { targetKind: 'element', targetId: 'e' } }] },
        { type: 'hardBreak' },
        { type: 'text', text: '窗', marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'https://example.test' } }] },
        { type: 'text', text: '外', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      ],
    },
    { type: 'horizontalRule', attrs: { id: 'r' } },
    { type: 'blockquote', attrs: { id: 'q' }, content: [{ type: 'paragraph', attrs: { id: 'qp', textAlign: 'right' }, content: [{ type: 'text', text: '引文' }] }] },
    { type: 'paragraph', content: [] },
  ],
};

describe('share document v1', () => {
  it('keeps block ids, marks, breaks and quotes as the reader copy', () => {
    expect(proseJsonToShareDocument(prose, `  ${'雨'.repeat(250)}`, 'chapter')).toEqual({
      v: 1,
      title: '雨'.repeat(198),
      kind: 'chapter',
      blocks: [
        { id: 'h', type: 'heading', runs: [{ text: '第一节' }], level: 2, align: 'center' },
        { id: 'p', type: 'paragraph', indent: 2, runs: [
          { text: '她推开', marks: ['bold'] },
          { text: '', br: true },
          { text: '窗', marks: ['italic'], href: 'https://example.test/' },
          { text: '外' },
        ] },
        { id: 'r', type: 'rule', runs: [] },
        { id: 'qp', type: 'paragraph', runs: [{ text: '引文' }], quote: true, align: 'right' },
        { id: null, type: 'paragraph', runs: [] },
      ],
    });
  });

  it('matches the editor block text that comment offsets index', () => {
    const doc = schemaForProfile('prose').nodeFromJSON(prose);
    const editorText: string[] = [];
    doc.descendants(node => {
      if (node.isTextblock) editorText.push(node.textContent);
    });
    const blocks = proseJsonToShareDocument(prose, 'x', 'chapter').blocks.filter(block => block.type !== 'rule');
    expect(blocks.map(shareBlockText)).toEqual(editorText);
  });

  it('tolerates an empty or malformed body', () => {
    expect(proseJsonToShareDocument(null, 'x', 'drift').blocks).toEqual([]);
    expect(proseJsonToShareDocument({ content: 'nope' as never }, 'x', 'element').blocks).toEqual([]);
  });
});
