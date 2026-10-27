import { describe, expect, it } from 'vitest';
import { createPlainCommentDoc } from '../../domain/comment';
import { legacyUrlNoteBodyJson, type LibraryItem } from '../../domain/library-item';
import { libraryItemMatchesQuery } from './library-item-search';

const base = {
  projectId: 'synthetic-project',
  notesJson: null,
  provenanceJson: null,
  orderKey: 0, folderId: null, taskTodos: true,
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

const retiredLinkNote: LibraryItem = {
  ...base,
  id: 'synthetic-retired-link',
  kind: 'text',
  title: '参考链接',
  assetId: null,
  externalUrl: null,
  previewImageUrl: null,
  bodyJson: legacyUrlNoteBodyJson('https://example.com/lighthouse-history'),
  notesJson: createPlainCommentDoc('潮汐表在第二页'),
};

describe('library item search', () => {
  it('ignores TipTap structure keywords in a text body', () => {
    for (const keyword of ['paragraph', 'type', 'doc', 'content', '"text"']) {
      expect(libraryItemMatchesQuery(textItem, keyword)).toBe(false);
    }
  });

  it('matches Chinese body text, title, a retired link and notes as plain text', () => {
    expect(libraryItemMatchesQuery(textItem, '第三盏灯')).toBe(true);
    expect(libraryItemMatchesQuery(textItem, '灯塔')).toBe(true);
    expect(libraryItemMatchesQuery(retiredLinkNote, 'lighthouse-history')).toBe(true);
    expect(libraryItemMatchesQuery(retiredLinkNote, '潮汐表')).toBe(true);
    expect(libraryItemMatchesQuery(retiredLinkNote, 'paragraph')).toBe(false);
    expect(libraryItemMatchesQuery(retiredLinkNote, 'href')).toBe(false);
  });

  it('treats a blank query as matching everything', () => {
    expect(libraryItemMatchesQuery(textItem, '   ')).toBe(true);
  });
});
