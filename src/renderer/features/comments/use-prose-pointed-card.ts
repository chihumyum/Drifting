import { type RefObject, useEffect, useSyncExternalStore } from 'react';

import { getPointedCommentHighlights, subscribePointedCommentHighlights } from '../../lib/comment-highlight';

// Room left above or below a card brought into view.
const VIEW_MARGIN = 8;

/** The nearest ancestor that scrolls vertically and has something to scroll. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Whether this comment's anchor is pointed at in the prose (lib/comment-sand.ts).
 * When it becomes so, the card is scrolled into its list's view, only if that
 * list is on screen: a closed or folded panel is left as it is.
 */
export function useProsePointedCard(commentId: string, cardRef: RefObject<HTMLElement | null>): boolean {
  const isPointed = () => getPointedCommentHighlights().includes(commentId);
  const pointed = useSyncExternalStore(subscribePointedCommentHighlights, isPointed, isPointed);
  useEffect(() => {
    const card = cardRef.current;
    if (!pointed || !card) return;
    const box = card.getBoundingClientRect();
    if (box.height === 0) return;
    const scroller = scrollerOf(card);
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    if (view.width === 0 || view.right <= 0 || view.left >= window.innerWidth) return;
    const above = box.top - view.top - VIEW_MARGIN;
    const below = box.bottom - view.bottom + VIEW_MARGIN;
    const delta = above < 0 ? above : below > 0 ? Math.min(below, above) : 0;
    if (delta === 0) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollBy({ top: delta, behavior: reduced ? 'auto' : 'smooth' });
  }, [pointed, cardRef]);
  return pointed;
}
