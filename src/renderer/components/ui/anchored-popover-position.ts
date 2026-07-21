export type AnchoredPopoverPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end';

interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface PopoverSize {
  width: number;
  height: number;
}

export interface AnchoredPopoverPosition {
  top: number;
  left: number;
  maxHeight: number;
  resolvedPlacement: AnchoredPopoverPlacement;
}

interface ComputeAnchoredPositionOptions {
  anchor: RectLike;
  popover: PopoverSize;
  viewportWidth: number;
  viewportHeight: number;
  placement: AnchoredPopoverPlacement;
  offset: number;
  viewportPadding: number;
}

/**
 * Compute a fixed-position popover origin. The preferred vertical side flips
 * when the opposite side has more room, then both axes clamp to the viewport.
 */
export function computeAnchoredPopoverPosition({
  anchor,
  popover,
  viewportWidth,
  viewportHeight,
  placement,
  offset,
  viewportPadding,
}: ComputeAnchoredPositionOptions): AnchoredPopoverPosition {
  const preferTop = placement.startsWith('top');
  const alignEnd = placement.endsWith('end');
  const spaceAbove = anchor.top - viewportPadding - offset;
  const spaceBelow = viewportHeight - viewportPadding - anchor.bottom - offset;
  const shouldFlip = preferTop
    ? popover.height > spaceAbove && spaceBelow > spaceAbove
    : popover.height > spaceBelow && spaceAbove > spaceBelow;
  const useTop = shouldFlip ? !preferTop : preferTop;
  const resolvedPlacement = `${useTop ? 'top' : 'bottom'}-${alignEnd ? 'end' : 'start'}` as const;

  const unclampedTop = useTop
    ? anchor.top - offset - popover.height
    : anchor.bottom + offset;
  const unclampedLeft = alignEnd ? anchor.right - popover.width : anchor.left;
  const maxTop = Math.max(viewportPadding, viewportHeight - viewportPadding - popover.height);
  const maxLeft = Math.max(viewportPadding, viewportWidth - viewportPadding - popover.width);

  return {
    top: Math.min(Math.max(unclampedTop, viewportPadding), maxTop),
    left: Math.min(Math.max(unclampedLeft, viewportPadding), maxLeft),
    maxHeight: Math.max(0, viewportHeight - viewportPadding * 2),
    resolvedPlacement,
  };
}
