import { describe, expect, it } from 'vitest';
import {
  GUIDE_CARD_GAP,
  GUIDE_CARD_MARGIN,
  GUIDE_RING_OUTSET,
  guideRingRect,
  placeGuideCard,
  unionGuideRect,
} from './tour-geometry';

const viewport = { width: 1440, height: 900 };
const card = { width: 268, height: 150 };

describe('unionGuideRect', () => {
  it('rings both halves of a split sidebar together and skips what is not shown', () => {
    expect(unionGuideRect([
      { left: 94, top: 7, width: 150, height: 28 },
      { left: 300, top: 7, width: 160, height: 28 },
      { left: 0, top: 0, width: 0, height: 0 },
    ])).toEqual({ left: 94, top: 7, width: 366, height: 28 });
  });

  it('has nothing to ring when nothing shows', () => {
    expect(unionGuideRect([])).toBeNull();
    expect(unionGuideRect([{ left: 10, top: 10, width: 0, height: 20 }])).toBeNull();
  });
});

describe('guideRingRect', () => {
  it('keeps a round button round', () => {
    const ring = guideRingRect({ left: 100, top: 100, width: 28, height: 28 });
    expect(ring.width).toBe(28 + GUIDE_RING_OUTSET * 2);
    expect(ring.radius).toBe(ring.height / 2);
  });

  it('gives a wide row soft corners', () => {
    expect(guideRingRect({ left: 0, top: 0, width: 400, height: 80 }).radius).toBe(12);
  });
});

describe('placeGuideCard', () => {
  it('sits under the ring, its left edge with the ring', () => {
    const ring = { left: 90, top: 3, width: 160, height: 36 };
    expect(placeGuideCard(ring, card, viewport)).toEqual({ left: 90, top: 3 + 36 + GUIDE_CARD_GAP });
  });

  it('goes above a control at the bottom of the window, right edges together', () => {
    const ring = { left: 1380, top: 852, width: 36, height: 36 };
    expect(placeGuideCard(ring, card, viewport)).toEqual({
      left: 1380 + 36 - card.width,
      top: 852 - GUIDE_CARD_GAP - card.height,
    });
  });

  it('never runs off the window', () => {
    const ring = { left: 1400, top: 3, width: 36, height: 36 };
    expect(placeGuideCard(ring, card, viewport).left).toBe(viewport.width - GUIDE_CARD_MARGIN - card.width);
    const tall = placeGuideCard({ left: 0, top: 0, width: 300, height: 880 }, card, viewport);
    expect(tall.left).toBe(300 + GUIDE_CARD_GAP);
    expect(tall.top).toBe(GUIDE_CARD_MARGIN);
  });
});
