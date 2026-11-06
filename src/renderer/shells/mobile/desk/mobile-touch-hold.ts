import { openHoverCardsNow } from '../../../features/entities/hover/entity-hover-card-model';

/**
 * The phone's long press (docs/design-system/touch.md). A finger held still on
 * a thing for HOLD_MS brings up that thing's own card: the same card a pointer
 * resting on it brings up on the desktop, with the same actions, so every
 * chapter, element, drift, timeline block or review card answers the hold
 * without a second, phone-only menu. Keeping the finger down and sliding onto a
 * row of the card, then lifting, presses that row.
 *
 * The hold replays a pointer arriving on the thing (`mouseover` and a mouse
 * `pointerover`, which React turns into enter events) inside
 * `openHoverCardsNow`, so the card skips its hover delay. The click a lifted
 * finger would send after a hold is swallowed. Prose, fields and anything
 * marked `data-touch-hold="off"` keep the system's own long press (text
 * selection, the loupe).
 */

export const TOUCH_HOLD_MS = 420;
const TOUCH_SLOP_PX = 8;
const SWALLOW_CLICK_MS = 450;
const CARD_SELECTOR = '.hover-card-surface';
const ROW_SELECTOR = `${CARD_SELECTOR} button:not(:disabled), ${CARD_SELECTOR} [role="menuitem"]`;
const SYSTEM_HOLD_SELECTOR = '[contenteditable="true"], input, textarea, select, [data-touch-hold="off"]';

interface Hold {
  pointerId: number;
  x: number;
  y: number;
  target: Element;
  timer: number;
  fired: boolean;
  armed: HTMLElement | null;
}

function replayArrival(target: Element): void {
  const init = { bubbles: true, cancelable: true, composed: true, view: window, relatedTarget: document.body };
  openHoverCardsNow(() => {
    target.dispatchEvent(new MouseEvent('mouseover', init));
    if (typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerType: 'mouse', isPrimary: true }));
    }
  });
}

function arm(hold: Hold, x: number, y: number): void {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(ROW_SELECTOR) ?? null;
  if (row === hold.armed) return;
  hold.armed?.removeAttribute('data-touch-armed');
  hold.armed = row;
  row?.setAttribute('data-touch-armed', 'true');
}

export function installTouchHold(root: HTMLElement, onHold?: (target: Element) => void): () => void {
  let hold: Hold | null = null;
  let swallowUntil = 0;

  const cancel = () => {
    if (!hold) return;
    window.clearTimeout(hold.timer);
    hold.armed?.removeAttribute('data-touch-armed');
    hold = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    cancel();
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest(SYSTEM_HOLD_SELECTOR) || target.closest(CARD_SELECTOR)) return;
    const current: Hold = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target,
      fired: false,
      armed: null,
      timer: window.setTimeout(() => {
        if (hold !== current || !target.isConnected) return;
        current.fired = true;
        replayArrival(target);
        onHold?.(target);
      }, TOUCH_HOLD_MS),
    };
    hold = current;
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!hold || event.pointerId !== hold.pointerId) return;
    if (hold.fired) {
      arm(hold, event.clientX, event.clientY);
      return;
    }
    if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > TOUCH_SLOP_PX) cancel();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!hold || event.pointerId !== hold.pointerId) return;
    const { fired, armed } = hold;
    cancel();
    if (!fired) return;
    swallowUntil = performance.now() + SWALLOW_CLICK_MS;
    if (armed && armed.isConnected) {
      // The finger slid onto a row of the card and lifted there.
      window.setTimeout(() => armed.click(), 0);
    }
  };

  const onClick = (event: MouseEvent) => {
    if (performance.now() > swallowUntil) return;
    if (event.target instanceof Element && event.target.closest(CARD_SELECTOR)) return;
    swallowUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  // A held finger must not also open the system's callout or a context menu.
  const onContextMenu = (event: Event) => {
    if (hold?.fired) event.preventDefault();
  };

  root.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('scroll', cancel, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('contextmenu', onContextMenu, true);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('scroll', cancel, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
  };
}
