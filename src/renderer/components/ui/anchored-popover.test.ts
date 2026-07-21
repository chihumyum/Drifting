import { describe, expect, it } from 'vitest';
import { computeAnchoredPopoverPosition } from './anchored-popover-position';

const anchor = {
  top: 40,
  right: 120,
  bottom: 60,
  left: 80,
  width: 40,
  height: 20,
};

describe('computeAnchoredPopoverPosition', () => {
  it('keeps a bottom-start popover next to its anchor when there is room', () => {
    expect(
      computeAnchoredPopoverPosition({
        anchor,
        popover: { width: 160, height: 100 },
        viewportWidth: 600,
        viewportHeight: 500,
        placement: 'bottom-start',
        offset: 6,
        viewportPadding: 8,
      }),
    ).toMatchObject({ top: 66, left: 80, resolvedPlacement: 'bottom-start' });
  });

  it('flips above the anchor when the preferred bottom side would overflow', () => {
    const nearBottom = { ...anchor, top: 450, bottom: 470 };
    expect(
      computeAnchoredPopoverPosition({
        anchor: nearBottom,
        popover: { width: 160, height: 120 },
        viewportWidth: 600,
        viewportHeight: 500,
        placement: 'bottom-end',
        offset: 6,
        viewportPadding: 8,
      }),
    ).toMatchObject({ top: 324, left: 8, resolvedPlacement: 'top-end' });
  });

  it('clamps oversized horizontal placement inside the viewport gutter', () => {
    const nearRight = { ...anchor, left: 570, right: 590 };
    expect(
      computeAnchoredPopoverPosition({
        anchor: nearRight,
        popover: { width: 180, height: 100 },
        viewportWidth: 600,
        viewportHeight: 500,
        placement: 'bottom-start',
        offset: 6,
        viewportPadding: 8,
      }).left,
    ).toBe(412);
  });
});
