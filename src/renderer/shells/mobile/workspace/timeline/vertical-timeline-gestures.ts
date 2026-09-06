import {
  MOBILE_PLANNING_CONTEXT_MENU_MS,
  MOBILE_PLANNING_MOVE_TOLERANCE_PX,
  resolveMobilePlanningGesture,
} from '../../../../features/graph/mobile-planning-gesture';

/** Long-press hit radius along the axis: a finger lands on the nearest dot by y. */
export const VERTICAL_TIMELINE_DOT_HIT_PX = 22;

export interface VerticalDotCandidate {
  readonly id: string;
  readonly y: number;
}

/** Nearest dot to a track-space y within the hit radius (ties: the earlier one). */
export function nearestVerticalDot<T extends VerticalDotCandidate>(
  dots: readonly T[],
  y: number,
  radius = VERTICAL_TIMELINE_DOT_HIT_PX,
): T | null {
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const dot of dots) {
    const distance = Math.abs(dot.y - y);
    if (distance <= radius && distance < bestDistance) {
      best = dot;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Midpoint coordinates between consecutive placed chapters (plus one slot
 * before the first and one after the last). The menu's "move position…" and
 * the drawer's "place here" write these; the direct drag writes the pointer's
 * continuous coordinate instead.
 */
export function verticalTimelineSlots(
  orders: readonly number[],
  stride: number,
): Array<{ afterIndex: number; order: number }> {
  const sorted = [...orders].sort((a, b) => a - b);
  if (sorted.length === 0) return [{ afterIndex: -1, order: 1 }];
  const slots = [{ afterIndex: -1, order: sorted[0]! - stride }];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    slots.push({ afterIndex: index, order: (sorted[index]! + sorted[index + 1]!) / 2 });
  }
  slots.push({ afterIndex: sorted.length - 1, order: sorted[sorted.length - 1]! + stride });
  return slots;
}

interface StartVerticalHandleDragInput {
  pointerId: number;
  pointerType: string;
  startClientX: number;
  startClientY: number;
  /** Live y while dragging (client space). */
  onMove: (clientY: number) => void;
  /** Released after a drag. */
  onDrop: (clientY: number) => void;
  /** Released without dragging (a tap). */
  onTap: () => void;
  onEnd: () => void;
}

/**
 * Pointer lifecycle for the act boundary handles and marker heads: touch
 * arms after MOBILE_PLANNING_DRAG_ARM_MS and drags once it moves, a still
 * hold past MOBILE_PLANNING_CONTEXT_MENU_MS lifts, an early pan scrolls the
 * list instead, a mouse drags immediately.
 */
export function startVerticalHandleDrag({
  pointerId,
  pointerType,
  startClientX,
  startClientY,
  onMove,
  onDrop,
  onTap,
  onEnd,
}: StartVerticalHandleDragInput): { cancel: () => void } {
  const touch = pointerType === 'touch';
  const startedAt = Date.now();
  let dragging = false;
  let lifted = false;
  let settled = false;
  const liftTimer = touch
    ? window.setTimeout(() => {
        if (!settled && !dragging) lifted = true;
      }, MOBILE_PLANNING_CONTEXT_MENU_MS)
    : 0;
  const stop = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleCancel);
    if (liftTimer) window.clearTimeout(liftTimer);
    document.documentElement.classList.remove('chapter-lane-pointer-dragging');
  };
  const handleMove = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    const distance = Math.hypot(event.clientX - startClientX, event.clientY - startClientY);
    if (!dragging) {
      if (touch && !lifted) {
        const intent = resolveMobilePlanningGesture({
          surface: 'card',
          elapsedMs: Date.now() - startedAt,
          distancePx: distance,
          pointerCount: 1,
        });
        if (intent === 'pan') {
          settled = true;
          stop();
          return;
        }
        if (intent !== 'drag') return;
      } else if (distance < (touch ? MOBILE_PLANNING_MOVE_TOLERANCE_PX : 3)) {
        return;
      }
      dragging = true;
      document.documentElement.classList.add('chapter-lane-pointer-dragging');
    }
    if (event.cancelable) event.preventDefault();
    onMove(event.clientY);
  };
  const handleUp = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    settled = true;
    stop();
    if (dragging) onDrop(event.clientY);
    else if (!lifted) onTap();
    onEnd();
  };
  const handleCancel = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    settled = true;
    stop();
    onEnd();
  };
  window.addEventListener('pointermove', handleMove, { passive: false });
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleCancel);
  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      stop();
      onEnd();
    },
  };
}

interface StartLongPressInput {
  pointerId: number;
  pointerType: string;
  startClientX: number;
  startClientY: number;
  onLongPress: () => void;
}

/** A still touch hold on empty track opens the "create here" sheet. */
export function startVerticalLongPress({
  pointerId,
  pointerType,
  startClientX,
  startClientY,
  onLongPress,
}: StartLongPressInput): { cancel: () => void } {
  if (pointerType !== 'touch') return { cancel: () => undefined };
  let timer = window.setTimeout(() => {
    timer = 0;
    stop();
    onLongPress();
  }, MOBILE_PLANNING_CONTEXT_MENU_MS);
  const stop = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleEnd);
    window.removeEventListener('pointercancel', handleEnd);
  };
  const handleMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (
      Math.hypot(event.clientX - startClientX, event.clientY - startClientY) >
      MOBILE_PLANNING_MOVE_TOLERANCE_PX
    ) {
      stop();
    }
  };
  const handleEnd = (event: PointerEvent) => {
    if (event.pointerId === pointerId) stop();
  };
  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleEnd);
  window.addEventListener('pointercancel', handleEnd);
  return { cancel: stop };
}
