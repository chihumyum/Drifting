import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useHoverPreview, type EntityHoverTarget } from '../entities/hover/entity-hover-card-model';

// The Super View cards unfold the same choice sections as the sidebars'.
export { withDriftGroupChoices, withElementCategoryChoices } from '../entities/hover/hover-choices';

/**
 * Hover-card state for the Super View canvases, where the cards carry what
 * the right-click menus used to. While `blocked` (a click popover, link
 * picking, a relation dialog) no card opens; the owner dismisses a showing
 * card when a press, drag or pan starts.
 */
export function useCanvasHoverCard(blocked: boolean) {
  const hover = useHoverPreview<EntityHoverTarget>();
  const { preview, onEnter } = hover;

  // Read through a ref so `onEnter` stays stable: memoized lane rows and
  // cards should not re-render because a popover opened.
  const blockedRef = useRef(blocked);
  useLayoutEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);
  const enter = useCallback(
    (target: EntityHoverTarget, anchor: HTMLElement) => {
      if (!blockedRef.current) onEnter(target, anchor);
    },
    [onEnter],
  );

  // The card closes itself on Escape, but the Super View's Escape stack (on
  // window) would then also close the layer behind it, or the whole view.
  // Claiming the press before either listener runs keeps it to the card.
  useEffect(() => {
    if (!preview) return undefined;
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    window.addEventListener('keydown', claimEscape, true);
    return () => window.removeEventListener('keydown', claimEscape, true);
  }, [preview]);

  return { ...hover, onEnter: enter };
}
