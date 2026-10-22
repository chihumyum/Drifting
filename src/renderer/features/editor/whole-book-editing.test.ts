import { describe, expect, it } from 'vitest';

import { editingChapterIdFor } from './whole-book-editing';

const row = (id: string) => ({ getAttribute: (name: string) => (name === 'data-chapter-id' ? id : null) });
const element = (tagName: string, chapterId: string | null, isContentEditable = false) => ({
  tagName,
  isContentEditable,
  closest: (selector: string) => (selector === '[data-chapter-id]' && chapterId ? row(chapterId) : null),
});
const inside = { contains: () => true };
const outside = { contains: () => false };

describe('editingChapterIdFor', () => {
  it('finds the chapter whose prose, title or summary has focus', () => {
    expect(editingChapterIdFor(element('DIV', 'c1', true), inside)).toBe('c1');
    expect(editingChapterIdFor(element('TEXTAREA', 'c2'), inside)).toBe('c2');
  });

  it('does not treat ⁂ or other controls as editing', () => {
    expect(editingChapterIdFor(element('BUTTON', 'c1'), inside)).toBeNull();
  });

  it('ignores focus outside the whole-book scroller', () => {
    expect(editingChapterIdFor(element('DIV', 'c1', true), outside)).toBeNull();
    expect(editingChapterIdFor(null, inside)).toBeNull();
    expect(editingChapterIdFor(element('DIV', 'c1', true), null)).toBeNull();
  });
});
