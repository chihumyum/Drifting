import { describe, expect, it } from 'vitest';
import type { ShareBlock } from '../shared/share-document';
import { anchorForSelection, locateAnchor, tokenFromPath } from './anchor';

const block = (id: string | null, text: string, type: ShareBlock['type'] = 'paragraph'): ShareBlock =>
  ({ id, type, runs: type === 'rule' ? [] : [{ text }] });
const blocks = [
  block('a', '雨夜，她推开窗。'),
  block('rule', '', 'rule'),
  block('b', '  风把信吹进来。  '),
  block(null, '没有编号的段落'),
  block('c', '尾声'),
];

describe('reader comment anchors', () => {
  it('writes a single-block anchor exactly as the editor does', () => {
    expect(anchorForSelection(blocks, { index: 0, offset: 3 }, { index: 0, offset: 7 })).toEqual({
      targetBlockId: 'a',
      targetBlockIds: ['a'],
      selectedText: '她推开窗',
      blockText: '雨夜，她推开窗。',
      blockSelectionFrom: 3,
      blockSelectionTo: 7,
      blockSnapshots: [{ blockId: 'a', blockText: '雨夜，她推开窗。' }],
      textAnchor: { startBlockId: 'a', startOffset: 3, endBlockId: 'a', endOffset: 7, text: '她推开窗' },
    });
  });

  it('spans blocks, trims whitespace and skips unanchorable blocks', () => {
    const anchor = anchorForSelection(blocks, { index: 0, offset: 7 }, { index: 2, offset: 18 })!;
    expect(anchor.selectedText).toBe('。\n  风把信吹进来。');
    expect(anchor.targetBlockIds).toEqual(['a', 'b']);
    expect([anchor.blockSelectionFrom, anchor.blockSelectionTo]).toEqual([-1, -1]);
    expect(anchor.textAnchor).toEqual({ startBlockId: 'a', startOffset: 7, endBlockId: 'b', endOffset: 9, text: '。\n  风把信吹进来。' });
    expect(anchorForSelection(blocks, { index: 2, offset: 1 }, { index: 2, offset: 5 })?.textAnchor)
      .toMatchObject({ startOffset: 2, endOffset: 5, text: '风把信' });
    expect(anchorForSelection(blocks, { index: 2, offset: 0 }, { index: 2, offset: 2 })).toBeNull();
    expect(anchorForSelection(blocks, { index: 3, offset: 0 }, { index: 3, offset: 4 })).toBeNull();
    expect(anchorForSelection(blocks, { index: 0, offset: 4 }, { index: 0, offset: 4 })).toBeNull();
  });

  it('re-locates an anchor after the author edits around it, and gives up when it is rewritten', () => {
    const anchor = anchorForSelection(blocks, { index: 0, offset: 3 }, { index: 0, offset: 7 })!;
    expect(locateAnchor(blocks, anchor)).toEqual({ start: { index: 0, offset: 3 }, end: { index: 0, offset: 7 } });
    const edited = [block('new', '序'), { ...blocks[0]!, runs: [{ text: '那个雨夜，她推开窗。' }] }];
    expect(locateAnchor(edited, anchor)).toEqual({ start: { index: 1, offset: 5 }, end: { index: 1, offset: 9 } });
    expect(locateAnchor([block('a', '晴天')], anchor)).toBeNull();
    expect(locateAnchor([block('b', '她推开窗')], anchor)).toBeNull();

    const spanning = anchorForSelection(blocks, { index: 0, offset: 7 }, { index: 2, offset: 18 })!;
    expect(locateAnchor(blocks, spanning)).toEqual({ start: { index: 0, offset: 7 }, end: { index: 2, offset: 9 } });
    const moved = [{ ...blocks[0]!, runs: [{ text: '这是雨夜，她推开窗。' }] }, blocks[2]!];
    expect(locateAnchor(moved, spanning)).toEqual({ start: { index: 0, offset: 9 }, end: { index: 1, offset: 9 } });
  });

  it('reads the token from a reader path only', () => {
    expect(tokenFromPath('/s/abcdefghijklmnopqrstuvwxyz012345')).toBe('abcdefghijklmnopqrstuvwxyz012345');
    expect(tokenFromPath('/s/abcdefghijklmnop/')).toBe('abcdefghijklmnop');
    expect(tokenFromPath('/s/short')).toBeNull();
    expect(tokenFromPath('/s/abcdefghijklmnop/../x')).toBeNull();
  });
});
