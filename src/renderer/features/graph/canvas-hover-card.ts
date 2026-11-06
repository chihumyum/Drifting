import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useHoverPreview, type EntityHoverTarget } from '../entities/hover/entity-hover-card-model';

/**
 * Hover-card state for the Super View canvases, where the cards carry what
 * the right-click menus used to. While `blocked` (a click popover, link
 * picking, a relation dialog) no card opens; the owner dismisses a showing
 * card when a press, drag or pan starts.
 */
export function useCanvasHoverCard(blocked: boolean) {
  const hover = useHoverPreview<EntityHoverTarget>();
  const { preview, onEnter, dismiss } = hover;

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

  // Escape closes a showing card and nothing behind it. The press is claimed
  // before any other listener runs, so the Super View's Escape stack (on
  // window) leaves its layers and the view open; claimed, the card's own
  // Escape handler stands aside, so this closes the card itself.
  useEffect(() => {
    if (!preview) return undefined;
    const claimEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss();
    };
    window.addEventListener('keydown', claimEscape, true);
    return () => window.removeEventListener('keydown', claimEscape, true);
  }, [preview, dismiss]);

  return { ...hover, onEnter: enter };
}
