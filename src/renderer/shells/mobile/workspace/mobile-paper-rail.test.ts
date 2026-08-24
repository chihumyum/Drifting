import { describe, expect, it } from 'vitest';
import {
  mobilePaperRailAvailability,
  mobilePaperRailFromCommentVisibility,
  toggleMobilePaperRail,
} from './mobile-paper-rail';

describe('mobile paper rail', () => {
  it('offers both shared rails on entity papers', () => {
    expect(mobilePaperRailAvailability({ entityType: 'node', id: 'n1' })).toEqual({
      toc: true,
      comments: true,
    });
    expect(mobilePaperRailAvailability({ entityType: 'element', id: 'e1' })).toEqual({
      toc: true,
      comments: true,
    });
  });

  it('keeps TOC on whole-book papers and hides rails without a paper', () => {
    expect(mobilePaperRailAvailability({ entityType: 'all-chapters', id: 'all' })).toEqual({
      toc: true,
      comments: false,
    });
    expect(mobilePaperRailAvailability(null)).toEqual({
      toc: false,
      comments: false,
    });
  });

  it('keeps the two narrow-screen rails mutually exclusive', () => {
    expect(toggleMobilePaperRail(null, 'toc')).toBe('toc');
    expect(toggleMobilePaperRail('toc', 'comments')).toBe('comments');
    expect(toggleMobilePaperRail('comments', 'comments')).toBeNull();
  });

  it('mirrors editor-owned comment visibility in both directions', () => {
    expect(mobilePaperRailFromCommentVisibility(null, true, true)).toBe('comments');
    expect(mobilePaperRailFromCommentVisibility('toc', true, true)).toBe('comments');
    expect(mobilePaperRailFromCommentVisibility('comments', false, true)).toBeNull();
    expect(mobilePaperRailFromCommentVisibility('toc', false, true)).toBe('toc');
    expect(mobilePaperRailFromCommentVisibility('toc', true, false)).toBe('toc');
  });
});
