import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { takeTitle, titleFromFilename } from './title';

const text = (value: string): JSONContent[] => [{ type: 'text', text: value }];
const paragraph = (value: string): JSONContent => ({ type: 'paragraph', content: text(value) });
const heading = (level: number, value: string): JSONContent => ({ type: 'heading', attrs: { level }, content: text(value) });
const doc = (...blocks: JSONContent[]): JSONContent => ({ type: 'doc', content: blocks });

describe('imported document titles', () => {
  it('takes an opening level-1 heading as the title and off the body', () => {
    const imported = takeTitle(doc(heading(1, '第一章 序'), paragraph('我要给阿Q做正传。'), heading(1, '十分钟前')), '01 第一章 序.md');
    expect(imported.title).toBe('第一章 序');
    // A heading further down is a scene heading, not the title.
    expect(imported.doc).toEqual(doc(paragraph('我要给阿Q做正传。'), heading(1, '十分钟前')));
  });

  it('prefers the opening heading to the file name when they differ', () => {
    expect(takeTitle(doc(heading(1, 'The Storm'), paragraph('Rain.')), 'Chapter 3.md').title).toBe('The Storm');
  });

  it('names a document without an opening heading after its file, not its first sentence', () => {
    const body = doc(paragraph('吸铁石。'), paragraph('她说出这三个字的时候，声音不大。'));
    expect(takeTitle(body, '瓜摊.md')).toEqual({ doc: body, title: '瓜摊' });
    // A later heading does not become the title.
    expect(takeTitle(doc(paragraph('开场。'), heading(1, '十分钟前')), '瓜摊.txt').title).toBe('瓜摊');
  });

  it('drops an opening line that only repeats the file name', () => {
    expect(takeTitle(doc(paragraph('第一章  序'), paragraph('正文。')), '第一章 序.txt'))
      .toEqual({ doc: doc(paragraph('正文。')), title: '第一章 序' });
    expect(takeTitle(doc(heading(2, '瓜摊'), paragraph('正文。')), '瓜摊.md').doc).toEqual(doc(paragraph('正文。')));
  });

  it('leaves an empty paragraph when the title was all there was', () => {
    expect(takeTitle(doc(heading(1, '第七章 革命')), '07 第七章 革命.md'))
      .toEqual({ doc: doc({ type: 'paragraph' }), title: '第七章 革命' });
  });

  it('ignores an empty opening heading', () => {
    const body = doc({ type: 'heading', attrs: { level: 1 } }, paragraph('正文。'));
    expect(takeTitle(body, 'notes.md')).toEqual({ doc: body, title: 'notes' });
  });

  it('strips an ordering number from the file name but keeps years and bare numbers', () => {
    expect(titleFromFilename('01 第一章 序.md')).toBe('第一章 序');
    expect(titleFromFilename('2_chapter.md')).toBe('chapter');
    expect(titleFromFilename('03 - 夜车.docx')).toBe('夜车');
    expect(titleFromFilename('4. Ending.txt')).toBe('Ending');
    expect(titleFromFilename('2024-11-05 日记.md')).toBe('2024-11-05 日记');
    expect(titleFromFilename('1984.md')).toBe('1984');
    expect(titleFromFilename('12.md')).toBe('12');
  });
});
