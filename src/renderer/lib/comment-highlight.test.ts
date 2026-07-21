import { describe, expect, it } from 'vitest';
import { anchorTextMatches, findNearestTextOffset } from './comment-highlight';

describe('comment highlight anchor recovery', () => {
  it('rejects unrelated text even when stale offsets still form a range', () => {
    expect(anchorTextMatches('the wrong phrase', 'the anchored phrase')).toBe(false);
    expect(anchorTextMatches('the\n anchored   phrase', 'the anchored phrase')).toBe(true);
  });

  it('relocates a repeated phrase nearest to its original offset', () => {
    const text = 'echo at the start, then echo at the end';
    expect(findNearestTextOffset(text, 'echo', 0)).toBe(0);
    expect(findNearestTextOffset(text, 'echo', 27)).toBe(24);
  });

  it('does not invent a range when the captured phrase disappeared', () => {
    expect(findNearestTextOffset('rewritten prose', 'old phrase', 4)).toBeNull();
    expect(findNearestTextOffset('anything', '', 0)).toBeNull();
  });
});
