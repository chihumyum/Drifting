import { describe, expect, it } from 'vitest';
import { settleDrawer } from './useDeskPan';
import { foreEdgeAt, foreEdgeChapters } from './MobileForeEdge';

describe('pushing the paper aside', () => {
  const width = 320;

  it('opens the side it is pushed toward once it passes a third, or on a flick', () => {
    expect(settleDrawer(0, 120, 0, width)).toBe('left');
    expect(settleDrawer(0, 60, 0, width)).toBe('none');
    expect(settleDrawer(0, 40, 0.5, width)).toBe('left');
    expect(settleDrawer(0, -120, 0, width)).toBe('right');
    expect(settleDrawer(0, -30, -0.6, width)).toBe('right');
  });

  it('a flick against a small push does not open the other side', () => {
    expect(settleDrawer(0, 20, -0.6, width)).toBe('none');
    expect(settleDrawer(0, -20, 0.6, width)).toBe('none');
  });

  it('an open desk closes when pulled back past a third, or on a flick back', () => {
    expect(settleDrawer(width, width - 140, 0, width)).toBe('none');
    expect(settleDrawer(width, width - 40, 0, width)).toBe('left');
    expect(settleDrawer(width, width - 20, -0.5, width)).toBe('none');
    expect(settleDrawer(-width, -width + 140, 0, width)).toBe('none');
    expect(settleDrawer(-width, -width + 40, 0, width)).toBe('right');
  });
});

describe('the fore-edge', () => {
  const chapters = foreEdgeChapters([
    { id: 'a', title: 'A', words: 3000 },
    { id: 'b', title: 'B', words: 1000 },
    { id: 'c', title: 'C', words: 0 },
  ]);

  it('gives each chapter a stretch as long as its share of the words, in order', () => {
    expect(chapters.map((chapter) => chapter.id)).toEqual(['a', 'b', 'c']);
    expect(chapters[0].from).toBe(0);
    expect(chapters[chapters.length - 1].to).toBe(1);
    expect(chapters[0].to - chapters[0].from).toBeGreaterThan(chapters[1].to - chapters[1].from);
    for (let i = 1; i < chapters.length; i += 1) expect(chapters[i].from).toBeCloseTo(chapters[i - 1].to);
  });

  it('keeps an empty chapter reachable', () => {
    const empty = chapters[2];
    expect(empty.to - empty.from).toBeGreaterThan(0.005);
  });

  it('finds the chapter under the thumb and how far into it', () => {
    expect(foreEdgeAt(chapters, 0)?.chapter.id).toBe('a');
    expect(foreEdgeAt(chapters, 0)?.within).toBe(0);
    const middleOfB = (chapters[1].from + chapters[1].to) / 2;
    expect(foreEdgeAt(chapters, middleOfB)?.chapter.id).toBe('b');
    expect(foreEdgeAt(chapters, middleOfB)?.within).toBeCloseTo(0.5);
    expect(foreEdgeAt(chapters, 1)?.chapter.id).toBe('c');
    expect(foreEdgeAt(chapters, 2)?.chapter.id).toBe('c');
    expect(foreEdgeAt([], 0.5)).toBeNull();
  });
});
