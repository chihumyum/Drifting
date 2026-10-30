import { describe, expect, it } from 'vitest';
import { schemaForProfile } from '../renderer/lib/editor-schema-profile';
import { proseEntityLinks, proseJsonToShareDocument, shareBlockText, shareColor, shareEntity } from './share-document';

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

  it('keys linked entities in reading order with name, summary and colour only', () => {
    const link = (targetKind: string, targetId: string) => ({ type: 'entityLink', attrs: { targetKind, targetId, targetBlockId: null } });
    const body = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'a' }, content: [
          { type: 'text', text: '林岚', marks: [link('element', 'lin')] },
          { type: 'text', text: '在' },
          { type: 'text', text: '阁楼', marks: [link('element', 'attic'), { type: 'bold' }] },
          { type: 'text', text: '，见过', marks: [] },
          { type: 'text', text: '补丁', marks: [link('patch', 'p1')] },
          { type: 'text', text: '林', marks: [link('element', 'lin')] },
          { type: 'text', text: '岚', marks: [link('element', 'lin')] },
        ] },
      ],
    };
    const resolved: Record<string, ReturnType<typeof shareEntity>> = {
      'element:lin': shareEntity('element', '林岚', '  画家，雨夜失踪。  ', 'hsl(var(--story-1))'),
      'element:attic': shareEntity('element', '阁楼', '', 'url(javascript:x)'),
    };
    const document = proseJsonToShareDocument(body, '雨夜', 'chapter', {
      resolveEntity: (kind, id) => resolved[`${kind}:${id}`] ?? null,
      folio: { chapter: 3, line: { name: '主线', color: '#AA3300' }, words: 1234 },
    });
    expect(document.blocks[0]!.runs).toEqual([
      { text: '林岚', entity: 'e1' },
      { text: '在' },
      { text: '阁楼', marks: ['bold'], entity: 'e2' },
      { text: '，见过补丁' },
      { text: '林岚', entity: 'e1' },
    ]);
    expect(document.entities).toEqual({
      e1: { kind: 'element', name: '林岚', summary: '画家，雨夜失踪。', color: 'hsl(var(--story-1))' },
      e2: { kind: 'element', name: '阁楼' },
    });
    expect(Object.keys(document)).toEqual(['v', 'title', 'kind', 'blocks', 'folio', 'entities']);
    expect(document.folio).toEqual({ chapter: 3, line: { name: '主线', color: '#AA3300' }, words: 1234 });
    expect(proseEntityLinks(body)).toEqual([
      { kind: 'element', id: 'lin' }, { kind: 'element', id: 'attic' }, { kind: 'patch', id: 'p1' },
    ]);
  });

  it('accepts only stored colour forms and drops an empty folio', () => {
    expect(['#abc', '#A1B2C3', '#a1b2c3d4', 'hsl(var(--story-2))'].map(shareColor)).toEqual(['#abc', '#A1B2C3', '#a1b2c3d4', 'hsl(var(--story-2))']);
    expect(['red', 'hsl(0 0% 0%)', 'url(x)', 'hsl(var(--x);color:red)', '#12'].map(shareColor)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(proseJsonToShareDocument(prose, 'x', 'element', { folio: { line: { name: '' }, chapter: 0 } })).not.toHaveProperty('folio');
    expect(shareEntity('node', 'x'.repeat(300), 'y'.repeat(3000)).name).toHaveLength(200);
    expect(shareEntity('node', 'x', 'y'.repeat(3000)).summary).toHaveLength(2000);
  });

  it('tolerates an empty or malformed body', () => {
    expect(proseJsonToShareDocument(null, 'x', 'drift').blocks).toEqual([]);
    expect(proseJsonToShareDocument({ content: 'nope' as never }, 'x', 'element').blocks).toEqual([]);
  });
});
