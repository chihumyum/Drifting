import { describe, expect, it } from 'vitest';
import { numberProseLines, proseReadMarkdown, proseReadVersion, proseReadWindow } from './prose-read-view';
import { docToBlocks } from './serialize';
import { searchExactProse } from './exact-prose-search';

describe('shared prose reading and literal search', () => {
  it('preserves empty blocks and hard breaks in the body-only line coordinate system', () => {
    const body = proseReadMarkdown(JSON.stringify({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: '雨😀' }, { type: 'hardBreak' }, { type: 'text', text: 'Next' }] },
    ] }));
    expect(body).toBe('## Title\n\n\n\n雨😀<br>Next');
    expect(docToBlocks(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Before' }, { type: 'hardBreak' }, { type: 'text', text: 'After' },
    ] }] }), true)[0]!.text).toBe('Before\nAfter');
    const page = proseReadWindow(body, { startLine: 5, endLine: 5, limit: 2 });
    expect(page).toMatchObject({ page: '雨😀', lineStart: 5, truncated: true });
    const next = proseReadWindow(body, { offset: page.nextOffset });
    expect(next).toMatchObject({ page: '<br>Next', lineStart: 5, startsMidLine: true, truncated: false });
    expect(numberProseLines(next.page, next.lineStart)).toBe('5\t<br>Next');
  });
  it('rejects invalid ranges and produces content-sensitive versions', async () => {
    expect(() => proseReadWindow('one\n\ntwo', { startLine: 4 })).toThrow('Line range');
    expect(() => proseReadWindow('one\n\ntwo', { startLine: 3, offset: 1 })).toThrow('cursor');
    expect(await proseReadVersion('雨')).not.toBe(await proseReadVersion('雪'));
  });
  it('matches every literal occurrence, preserves punctuation and pages with a version guard', async () => {
    const documents = [{ evidenceId: 'chapter:1', kind: 'chapter', title: 'Only title hit: elsewhere', fields: [
      { kind: 'prose' as const, block: 2, text: '雨夜归人。雨夜。A.* A.* a.* Ａ.* 😀' },
    ] }];
    const first = await searchExactProse(documents, 'A.*', { limit: 1 });
    expect(first).toMatchObject({ total: 2, truncated: true, nextCursor: 1 });
    expect(first.matches[0]).toMatchObject({ block: 2, line: 3 });
    const second = await searchExactProse(documents, 'A.*', { limit: 10, cursor: 1, version: first.version });
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]!.textStart).toBeGreaterThan(first.matches[0]!.textStart);
    expect((await searchExactProse(documents, 'A.*', { limit: 10, caseSensitive: false })).total).toBe(3);
    expect((await searchExactProse(documents, '雨夜归人', { limit: 10 })).total).toBe(1);
    expect((await searchExactProse(documents, 'elsewhere', { limit: 10 })).total).toBe(0);
    documents[0]!.fields[0]!.text += 'changed';
    await expect(searchExactProse(documents, 'A.*', { limit: 1, cursor: 1, version: first.version })).rejects.toThrow('changed');
  });
});
