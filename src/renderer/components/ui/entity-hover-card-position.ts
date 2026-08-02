export type EntityHoverCardPlacement = 'right-start' | 'top-center' | 'bottom-start';

interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface EntityHoverCardPositionOptions {
  anchor: RectLike;
  card: { width: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
  placement: EntityHoverCardPlacement;
  offset?: number;
  viewportPadding?: number;
  maxHeight?: number;
}

export interface EntityHoverCardPosition {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Position a fixed hover card beside inline text, a sidebar row, or a timeline
 * clip. Preferred sides flip when the opposite side has more room, then clamp
 * to the viewport. The card may grow naturally up to `maxHeight`.
 */
export function computeEntityHoverCardPosition({
  anchor,
  card,
  viewportWidth,
  viewportHeight,
  placement,
  offset = 8,
  viewportPadding = 12,
  maxHeight = 720,
}: EntityHoverCardPositionOptions): EntityHoverCardPosition {
  const availableHeight = Math.max(0, viewportHeight - viewportPadding * 2);
  const resolvedMaxHeight = Math.min(maxHeight, availableHeight);
  const measuredHeight = Math.min(card.height, resolvedMaxHeight);
  let top: number;
  let left: number;

  if (placement === 'right-start') {
    const spaceRight = viewportWidth - viewportPadding - anchor.right - offset;
    const spaceLeft = anchor.left - viewportPadding - offset;
    const useLeft = card.width > spaceRight && spaceLeft > spaceRight;
    left = useLeft ? anchor.left - offset - card.width : anchor.right + offset;
    top = anchor.top;
  } else {
    const preferTop = placement === 'top-center';
    const spaceAbove = anchor.top - viewportPadding - offset;
    const spaceBelow = viewportHeight - viewportPadding - anchor.bottom - offset;
    const useTop = preferTop
      ? !(measuredHeight > spaceAbove && spaceBelow > spaceAbove)
      : measuredHeight > spaceBelow && spaceAbove > spaceBelow;
    top = useTop ? anchor.top - offset - measuredHeight : anchor.bottom + offset;
    left =
      placement === 'top-center'
        ? anchor.left + anchor.width / 2 - card.width / 2
        : anchor.left;
  }

  const maxTop = Math.max(viewportPadding, viewportHeight - viewportPadding - measuredHeight);
  const maxLeft = Math.max(viewportPadding, viewportWidth - viewportPadding - card.width);
  return {
    top: Math.min(Math.max(top, viewportPadding), maxTop),
    left: Math.min(Math.max(left, viewportPadding), maxLeft),
    maxHeight: resolvedMaxHeight,
  };
}
