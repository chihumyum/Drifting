import { describe, expect, it } from 'vitest';
import { createPlainCommentDoc } from '../../domain/comment';
import type { LibraryItem } from '../../domain/library-item';
import { libraryItemMatchesQuery } from './library-item-search';

const base = {
  projectId: 'synthetic-project',
  notesJson: null,
  provenanceJson: null,
  orderKey: 0,
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
};

const textItem: LibraryItem = {
  ...base,
  id: 'synthetic-text',
  kind: 'text',
  title: '灯塔笔记',
  assetId: null,
  externalUrl: null,
  previewImageUrl: null,
  bodyJson: createPlainCommentDoc('守夜人在雾里点亮了第三盏灯'),
};

const urlItem: LibraryItem = {
  ...base,
  id: 'synthetic-url',
  kind: 'url',
  title: '参考链接',
  assetId: null,
  externalUrl: 'https://example.com/lighthouse-history',
  previewImageUrl: null,
  bodyJson: null,
  notesJson: createPlainCommentDoc('潮汐表在第二页'),
};

describe('library item search', () => {
  it('ignores TipTap structure keywords in a text body', () => {
    for (const keyword of ['paragraph', 'type', 'doc', 'content', '"text"']) {
      expect(libraryItemMatchesQuery(textItem, keyword)).toBe(false);
    }
  });

  it('matches Chinese body text, title, link and notes as plain text', () => {
    expect(libraryItemMatchesQuery(textItem, '第三盏灯')).toBe(true);
    expect(libraryItemMatchesQuery(textItem, '灯塔')).toBe(true);
    expect(libraryItemMatchesQuery(urlItem, 'lighthouse-history')).toBe(true);
    expect(libraryItemMatchesQuery(urlItem, '潮汐表')).toBe(true);
    expect(libraryItemMatchesQuery(urlItem, 'paragraph')).toBe(false);
  });

  it('treats a blank query as matching everything', () => {
    expect(libraryItemMatchesQuery(textItem, '   ')).toBe(true);
  });
});
