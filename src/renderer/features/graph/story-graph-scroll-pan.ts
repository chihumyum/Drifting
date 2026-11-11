const LEFT_PAN_BLOCKED_SELECTOR = [
  '.graph-tile',
  '.graph-pin',
  '.graph-rail__cell',
  '.graph-edge-grp',
  '.graph-drift-edge',
  '.actrail__label',
  '.actrail__divider',
  '.actrail__edit-field',
  'button',
  'input',
  'textarea',
  'select',
  'a',
  '[role="button"]',
  '[role="slider"]',
  '[contenteditable="true"]',
].join(', ');

const MIDDLE_PAN_BLOCKED_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

function resolveTargetElement(target: EventTarget | null): { closest(selector: string): Element | null } | null {
  if (!target || typeof target !== 'object') return null;
  const candidate = target as Partial<Element> & Partial<Node>;
  if (typeof candidate.closest === 'function') {
    return candidate as { closest(selector: string): Element | null };
  }
  if (candidate.parentElement && typeof candidate.parentElement.closest === 'function') {
    return candidate.parentElement;
  }
  return null;
}

export function isStoryGraphPanBlockedTarget(
  target: EventTarget | null,
  button: number,
): boolean {
  const element = resolveTargetElement(target);
  if (!element) return true;
  if (button === 1) {
    return element.closest(MIDDLE_PAN_BLOCKED_SELECTOR) !== null;
  }
  if (button === 0) {
    return element.closest(LEFT_PAN_BLOCKED_SELECTOR) !== null;
  }
  return true;
}

export interface StartStoryGraphPointerPanInput {
  container: HTMLElement;
  pointerId: number;
  pointerType: string;
  button: number;
  startClientX: number;
  startClientY: number;
  target: EventTarget | null;
  onPanStart?: () => void;
}

export interface StoryGraphPointerPanHandle {
  started: boolean;
  cancel: () => void;
}

/**
 * Mouse drag-to-pan for `.graph-scroll`, whose scrollbars are hidden.
 * Left-dragging blank canvas/track space waits for a 3px movement threshold so
 * clicks and double-clicks on empty axis/act/track bands stay native; middle-
 * dragging pans from anywhere outside text inputs and suppresses browser
 * middle-click autoscroll.
 */
export function startStoryGraphPointerPan({
  container,
  pointerId,
  pointerType,
  button,
  startClientX,
  startClientY,
  target,
  onPanStart,
}: StartStoryGraphPointerPanInput): StoryGraphPointerPanHandle {
  if (pointerType !== 'mouse' || isStoryGraphPanBlockedTarget(target, button)) {
    return { started: false, cancel: () => {} };
  }

  const threshold = button === 1 ? 0 : 3;
  const initialScrollLeft = container.scrollLeft;
  const initialScrollTop = container.scrollTop;
  let panning = false;
  let settled = false;

  const suppressTrailingClick = () => {
    let timer = 0;
    const eatClick = (event: MouseEvent) => {
      window.clearTimeout(timer);
      window.removeEventListener('click', eatClick, true);
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('click', eatClick, true);
    timer = window.setTimeout(() => {
      window.removeEventListener('click', eatClick, true);
    }, 0);
  };

  const stop = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleCancel);
    container.classList.remove('is-panning');
  };

  const handleMove = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    const dx = event.clientX - startClientX;
    const dy = event.clientY - startClientY;
    if (!panning) {
      if (Math.hypot(dx, dy) < threshold) return;
      panning = true;
      container.classList.add('is-panning');
      onPanStart?.();
    }
    if (event.cancelable) event.preventDefault();
    window.getSelection()?.removeAllRanges();
    container.scrollLeft = initialScrollLeft - dx;
    container.scrollTop = initialScrollTop - dy;
  };

  const handleUp = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    settled = true;
    const didPan = panning;
    stop();
    if (didPan && button === 0) {
      suppressTrailingClick();
    }
  };

  const handleCancel = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    settled = true;
    stop();
  };

  window.addEventListener('pointermove', handleMove, { passive: false });
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleCancel);

  return {
    started: true,
    cancel: () => {
      if (settled) return;
      settled = true;
      stop();
    },
  };
}

export interface StoryGraphWheelLikeEvent {
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
}

/**
 * When `.graph-scroll` overflows horizontally but has no vertical overflow
 * (e.g. 1-3 storylines), map a plain vertical mouse wheel to horizontal scroll
 * so mouse users are not stranded without visible scrollbars.
 */
export function applyStoryGraphWheelPan(
  container: HTMLElement,
  event: StoryGraphWheelLikeEvent,
): boolean {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.deltaX !== 0 ||
    event.deltaY === 0
  ) {
    return false;
  }
  const maxScrollLeft = container.scrollWidth - container.clientWidth;
  if (maxScrollLeft <= 0) return false;
  if (container.scrollHeight > container.clientHeight + 1) return false;

  const nextScrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, container.scrollLeft + event.deltaY),
  );
  if (nextScrollLeft === container.scrollLeft) return false;
  container.scrollLeft = nextScrollLeft;
  event.preventDefault?.();
  return true;
}
