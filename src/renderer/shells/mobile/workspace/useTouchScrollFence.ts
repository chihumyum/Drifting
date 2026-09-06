import { useEffect, type RefObject } from 'react';

/**
 * Keeps a touch that starts on an overlay from panning anything beneath it.
 *
 * A finger on a non-scrolling part of a fixed overlay has nothing of its own
 * to move, so WebKit hands the pan to whatever is next in line: the prose
 * scroll owner under the overlay, or, while the keyboard is up, the visual
 * viewport itself, which drags the whole page. The fence cancels every
 * touchmove except one that a scrollable part of the overlay can still
 * consume in that direction; those keep scrolling natively, and reaching
 * their end stops the finger rather than leaking the rest of the gesture.
 */
export interface ScrollBox {
  readonly overflowX: string;
  readonly overflowY: string;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

const SCROLLABLE_OVERFLOW = /auto|scroll/;

/** Whether this box can still move its content under a finger travelling (dx, dy). */
export function scrollBoxTakes(box: ScrollBox, dx: number, dy: number): boolean {
  if (Math.abs(dx) > Math.abs(dy)) {
    if (!SCROLLABLE_OVERFLOW.test(box.overflowX) || box.scrollWidth <= box.clientWidth) return false;
    // A finger moving right reveals content to the left, and vice versa.
    return dx > 0 ? box.scrollLeft > 0 : box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
  }
  if (!SCROLLABLE_OVERFLOW.test(box.overflowY) || box.scrollHeight <= box.clientHeight) return false;
  return dy > 0 ? box.scrollTop > 0 : box.scrollTop + box.clientHeight < box.scrollHeight - 1;
}

/** `chain` runs from the touch target up to the fence root, inclusive. */
export function touchScrollFenceAllows(chain: readonly ScrollBox[], dx: number, dy: number): boolean {
  if (dx === 0 && dy === 0) return true;
  return chain.some((box) => scrollBoxTakes(box, dx, dy));
}

function scrollChain(target: EventTarget | null, root: HTMLElement): ScrollBox[] {
  const chain: ScrollBox[] = [];
  let element: Element | null = target instanceof Element ? target : null;
  while (element) {
    if (element instanceof HTMLElement) {
      const style = getComputedStyle(element);
      chain.push({
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      });
    }
    if (element === root) break;
    element = element.parentElement;
  }
  return chain;
}

export function useTouchScrollFence<T extends HTMLElement>(ref: RefObject<T | null>, enabled: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) return undefined;
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || !start) return;
      const chain = scrollChain(event.target, root);
      if (touchScrollFenceAllows(chain, touch.clientX - start.x, touch.clientY - start.y)) return;
      if (event.cancelable) event.preventDefault();
    };
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
    };
  }, [enabled, ref]);
}
