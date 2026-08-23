export const MOBILE_PLANNING_DRAG_ARM_MS = 180;
export const MOBILE_PLANNING_CONTEXT_MENU_MS = 500;
export const MOBILE_PLANNING_MOVE_TOLERANCE_PX = 8;
export const MOBILE_PLANNING_EDGE_ZONE_PX = 48;
export const MOBILE_PLANNING_EDGE_MAX_STEP_PX = 18;

export type MobilePlanningGestureIntent =
  | 'pending'
  | 'tap'
  | 'armed'
  | 'drag'
  | 'menu'
  | 'pan'
  | 'pinch'
  | 'cancel';

export interface MobilePlanningGestureSample {
  surface: 'card' | 'background';
  elapsedMs: number;
  distancePx: number;
  pointerCount: number;
  ended?: boolean;
  cancelled?: boolean;
}

/** Pure ownership decision shared by production pointer handling and M5 tests. */
export function resolveMobilePlanningGesture({
  surface,
  elapsedMs,
  distancePx,
  pointerCount,
  ended = false,
  cancelled = false,
}: MobilePlanningGestureSample): MobilePlanningGestureIntent {
  if (cancelled) return 'cancel';
  if (pointerCount >= 2) return 'pinch';
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const distance = Number.isFinite(distancePx) ? Math.max(0, distancePx) : 0;

  if (surface === 'background') {
    if (distance > MOBILE_PLANNING_MOVE_TOLERANCE_PX) return 'pan';
    return ended ? 'tap' : 'pending';
  }

  if (distance <= MOBILE_PLANNING_MOVE_TOLERANCE_PX) {
    if (elapsed >= MOBILE_PLANNING_CONTEXT_MENU_MS) return 'menu';
    if (ended) return 'tap';
    if (elapsed >= MOBILE_PLANNING_DRAG_ARM_MS) return 'armed';
    return 'pending';
  }
  return elapsed >= MOBILE_PLANNING_DRAG_ARM_MS ? 'drag' : 'pan';
}

export interface MobilePlanningEdgeAutoscrollInput {
  clientX: number;
  left: number;
  right: number;
  scrollLeft: number;
  maxScrollLeft: number;
  edgeZonePx?: number;
  maxStepPx?: number;
}

/** One animation-frame scroll delta, eased by proximity to either edge. */
export function mobilePlanningEdgeAutoscrollDelta({
  clientX,
  left,
  right,
  scrollLeft,
  maxScrollLeft,
  edgeZonePx = MOBILE_PLANNING_EDGE_ZONE_PX,
  maxStepPx = MOBILE_PLANNING_EDGE_MAX_STEP_PX,
}: MobilePlanningEdgeAutoscrollInput): number {
  if (![clientX, left, right, scrollLeft, maxScrollLeft].every(Number.isFinite)) return 0;
  const zone = Math.max(1, edgeZonePx);
  const maxStep = Math.max(0, maxStepPx);
  const current = Math.max(0, scrollLeft);
  const maximum = Math.max(0, maxScrollLeft);
  if (clientX < left + zone && current > 0) {
    const pressure = Math.min(1, Math.max(0, (left + zone - clientX) / zone));
    return -Math.min(current, maxStep * pressure);
  }
  if (clientX > right - zone && current < maximum) {
    const pressure = Math.min(1, Math.max(0, (clientX - (right - zone)) / zone));
    return Math.min(maximum - current, maxStep * pressure);
  }
  return 0;
}
