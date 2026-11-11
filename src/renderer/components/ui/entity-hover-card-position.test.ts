import { describe, expect, it } from 'vitest';

import { computeEntityHoverCardPosition } from './entity-hover-card-position';

const anchor = { top: 300, right: 220, bottom: 320, left: 180, width: 40, height: 20 };

describe('computeEntityHoverCardPosition', () => {
  it('allows the summary card to grow up to the raised 720px ceiling', () => {
    expect(
      computeEntityHoverCardPosition({
        anchor,
        card: { width: 300, height: 900 },
        viewportWidth: 1200,
        viewportHeight: 1000,
        placement: 'right-start',
      }).maxHeight,
    ).toBe(720);
  });

  it('uses almost the full viewport on a shorter window', () => {
    expect(
      computeEntityHoverCardPosition({
        anchor,
        card: { width: 300, height: 900 },
        viewportWidth: 900,
        viewportHeight: 600,
        placement: 'bottom-start',
      }).maxHeight,
    ).toBe(576);
  });

  it('flips a sidebar card to the left near the right viewport edge', () => {
    const position = computeEntityHoverCardPosition({
      anchor: { ...anchor, left: 850, right: 890 },
      card: { width: 300, height: 240 },
      viewportWidth: 920,
      viewportHeight: 800,
      placement: 'right-start',
    });
    expect(position.left).toBe(542);
  });

  it('flips a timeline card below when there is not enough room above', () => {
    const position = computeEntityHoverCardPosition({
      anchor: { top: 20, right: 220, bottom: 40, left: 180, width: 40, height: 20 },
      card: { width: 300, height: 240 },
      viewportWidth: 920,
      viewportHeight: 800,
      placement: 'top-center',
    });
    expect(position.top).toBe(48);
  });

  it('steps beside a middle-lane tile on a high-DPI scaled viewport instead of covering it', () => {
    const midTile = { top: 240, right: 448, bottom: 304, left: 320, width: 128, height: 64 };
    const card = { width: 248, height: 360 };
    const rightPos = computeEntityHoverCardPosition({
      anchor: midTile,
      card,
      viewportWidth: 1097,
      viewportHeight: 569,
      placement: 'bottom-start',
    });
    expect(rightPos.left).toBe(midTile.right + 8);

    const nearRightTile = { ...midTile, left: 900, right: 1028 };
    const leftPos = computeEntityHoverCardPosition({
      anchor: nearRightTile,
      card,
      viewportWidth: 1097,
      viewportHeight: 569,
      placement: 'bottom-start',
    });
    expect(leftPos.left + card.width).toBe(nearRightTile.left - 8);
  });

  it('caps height into the roomier vertical gap when neither vertical nor horizontal side fits', () => {
    const wideAnchor = { top: 280, right: 360, bottom: 320, left: 20, width: 340, height: 40 };
    const pos = computeEntityHoverCardPosition({
      anchor: wideAnchor,
      card: { width: 248, height: 420 },
      viewportWidth: 390,
      viewportHeight: 560,
      placement: 'bottom-start',
    });
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(wideAnchor.top);
  });
});
