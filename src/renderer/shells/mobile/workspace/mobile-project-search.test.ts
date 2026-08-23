import { describe, expect, it } from 'vitest';
import {
  escapeMobileProjectSearchLike,
  mobileSearchTextFromJson,
  searchMobileProjectPapers,
  type MobileProjectSearchPaper,
} from './mobile-project-search';

const papers: MobileProjectSearchPaper[] = [
  {
    target: { entityType: 'node', id: 'chapter-a' },
    title: '雨夜',
    fields: [
      { field: 'title', text: '雨夜' },
      { field: 'summary', text: '门外有雨。' },
      { field: 'body', text: '她在雨里等。雨没有停。' },
    ],
  },
  {
    target: { entityType: 'element', id: 'umbrella' },
    title: '旧伞',
    fields: [{ field: 'body', text: '伞面没有水。' }],
  },
];

describe('Mobile V2 headless Project paper search', () => {
  it('groups every occurrence by its ordinary paper target', () => {
    const groups = searchMobileProjectPapers('雨', papers);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      target: { entityType: 'node', id: 'chapter-a' },
      title: '雨夜',
      totalMatches: 4,
    });
    expect(groups[0].occurrences).toHaveLength(4);
  });

  it('is case-insensitive, literal, and never mutates its inputs', () => {
    const before = structuredClone(papers);
    expect(
      searchMobileProjectPapers('UMBRELLA', [
        {
          target: { entityType: 'element', id: 'e' },
          title: 'Umbrella',
          fields: [{ field: 'name', text: 'Umbrella_100%' }],
        },
      ])[0].totalMatches,
    ).toBe(1);
    expect(escapeMobileProjectSearchLike('100%_\\')).toBe('100\\%\\_\\\\');
    expect(papers).toEqual(before);
  });

  it('extracts prose text safely without exposing malformed JSON failures', () => {
    expect(
      mobileSearchTextFromJson(
        JSON.stringify({
          type: 'doc',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
            { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] },
          ],
        }),
      ),
    ).toBe('第一段\n第二段');
    expect(mobileSearchTextFromJson('{broken')).toBe('');
  });
});
