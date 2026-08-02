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
});
