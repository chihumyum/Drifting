import { describe, expect, it } from 'vitest';

import { inlineMarkdownInputPattern, inlineMarkdownPastePattern } from './inline-markdown-rules';

/** What markInputRule would mark: the matched markers and text, and the text it keeps. */
function typed(marker: Parameters<typeof inlineMarkdownInputPattern>[0], textBefore: string) {
  const match = inlineMarkdownInputPattern(marker).exec(textBefore);
  return match ? { full: match[0], text: match[match.length - 1] } : null;
}

describe('inline Markdown typed after a character', () => {
  it('bolds `**…**` inside Chinese prose, matching only the markers and their text', () => {
    expect(typed('**', '他把**吸铁石**')).toEqual({ full: '**吸铁石**', text: '吸铁石' });
    expect(typed('**', '“**吸铁石。**')).toEqual({ full: '**吸铁石。**', text: '吸铁石。' });
    expect(typed('**', '我来还那本**旧账本**')).toEqual({ full: '**旧账本**', text: '旧账本' });
    expect(typed('__', '他把__吸铁石__')).toEqual({ full: '__吸铁石__', text: '吸铁石' });
  });

  it('italicizes and strikes the same way', () => {
    expect(typed('*', '她说*再说吧*')).toEqual({ full: '*再说吧*', text: '再说吧' });
    expect(typed('_', '她说_再说吧_')).toEqual({ full: '_再说吧_', text: '再说吧' });
    expect(typed('~~', '十五斤~~三十块~~')).toEqual({ full: '~~三十块~~', text: '三十块' });
  });

  it('leaves the start of a block and the space before a marker to StarterKit', () => {
    expect(typed('**', '**吸铁石**')).toBeNull();
    expect(typed('**', 'a **bold**')).toBeNull();
    expect(typed('*', '*再说吧*')).toBeNull();
    expect(typed('~~', '~~三十块~~')).toBeNull();
  });

  it('does not fire half way through a pair of double markers', () => {
    // The first closing `*` of `**…**` is not an italic.
    expect(typed('*', '他把**吸铁石*')).toBeNull();
    expect(typed('**', '他把**')).toBeNull();
    expect(typed('**', '他把****')).toBeNull();
  });

  it('needs text that does not start or end with a space', () => {
    expect(typed('**', '他把** 吸铁石**')).toBeNull();
    expect(typed('**', '他把**吸铁石 **')).toBeNull();
    expect(typed('~~', '他~~ ~~')).toBeNull();
  });

  it('keeps single markers literal inside English words', () => {
    expect(typed('*', 'a*b*')).toBeNull();
    expect(typed('_', 'snake_case_')).toBeNull();
    expect(typed('__', 'dunder__init__')).toBeNull();
  });
});

describe('inline Markdown pasted inside Chinese prose', () => {
  const pasted = (marker: Parameters<typeof inlineMarkdownPastePattern>[0], text: string) =>
    [...text.matchAll(inlineMarkdownPastePattern(marker))].map((match) => match[0]);

  it('finds every pair after a character', () => {
    expect(pasted('**', '他把**吸铁石**拍在案板上，又把**瓜刀**拎起来。')).toEqual(['**吸铁石**', '**瓜刀**']);
    expect(pasted('~~', '十五斤~~三十块~~二十八块')).toEqual(['~~三十块~~']);
  });

  it('does not read a bold pair as an italic one', () => {
    expect(pasted('*', '他把**吸铁石**拍在案板上')).toEqual([]);
    expect(pasted('*', '她说*再说吧*。')).toEqual(['*再说吧*']);
  });
});
