import {
  MOBILE_PLANNING_CONTEXT_MENU_MS,
  mobilePlanningEdgeAutoscrollDelta,
  resolveMobilePlanningGesture,
} from './mobile-planning-gesture';

export const DEFAULT_STORYLINE_LANE_ID = '__default__';
export const UNAFFILIATED_STORYLINE_LANE_ID = '__unaffiliated__';

export type ChapterOrderField = 'bookOrder' | 'narrativeOrder';

interface CanDropChapterOnLaneInput {
  targetLaneId: string | null;
  fromDrawer: boolean;
  primaryStorylineId: string | null;
}

/**
 * Shared drop-target policy for Bottom Timeline and Storyline Graph.
 * Keeping this pure prevents the two desktop projections from drifting into
 * different membership rules as their visual layouts evolve independently.
 */
export function canDropChapterOnLane({
  targetLaneId,
  fromDrawer: _fromDrawer,
  primaryStorylineId: _primaryStorylineId,
}: CanDropChapterOnLaneInput): boolean {
  return targetLaneId !== null;
}

export interface ChapterLanePointerTarget {
  storylineId: string;
  order: number;
}

interface ChapterLaneSourceRect {
  left: number;
  width: number;
}

/** Preserve the exact horizontal pixel grabbed inside either card shape. */
export function chapterLaneGrabOffsetX(
  clientX: number,
  sourceRect: ChapterLaneSourceRect,
): number {
  return Math.min(sourceRect.width, Math.max(0, clientX - sourceRect.left));
}

interface ResolveChapterLanePointerTargetInput {
  clientX: number;
  clientY: number;
  grabOffsetX: number;
  positionToOrder: (position: number) => number;
}

/** Shared DOM hit-test and coordinate conversion for both chapter projections. */
export function resolveChapterLanePointerTarget({
  clientX,
  clientY,
  grabOffsetX,
  positionToOrder,
}: ResolveChapterLanePointerTargetInput): ChapterLanePointerTarget | null {
  const row = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>('[data-storyline-row]');
  const storylineId = row?.dataset.storylineRow;
  const track = row?.querySelector<HTMLElement>('[data-node-container]');
  if (!row || !storylineId || !track) return null;
  const rect = track.getBoundingClientRect();
  const x = Math.max(0, clientX - rect.left - grabOffsetX);
  return { storylineId, order: positionToOrder(x) };
}

interface StartChapterLanePointerDragInput {
  pointerId: number;
  pointerType: string;
  startClientX: number;
  startClientY: number;
  sourceElement: HTMLElement;
  grabOffsetX: number;
  resolveTarget: (clientX: number, clientY: number) => ChapterLanePointerTarget | null;
  onDragStart: () => void;
  onDrop: (target: ChapterLanePointerTarget) => void | Promise<void>;
  onDragEnd: () => void;
  mobileTouch?: {
    onMenu: () => void;
    scrollContainer: HTMLElement | null;
    /**
     * Which scroll axis the edge autoscroll follows: the desktop track pans
     * horizontally, the mobile vertical timeline scrolls downwards.
     */
    axis?: 'x' | 'y';
    /**
     * What a still hold does after MOBILE_PLANNING_CONTEXT_MENU_MS: open the
     * host menu (desktop's mobile presentation) or LIFT the source so the
     * following movement drags it (the vertical timeline, where a tap already
     * opens the menu). A lifted pointer released without moving simply
     * cancels; `onLift` lets the host show the lifted state.
     */
    holdBehavior?: 'menu' | 'lift';
    onLift?: () => void;
    /** A lifted pointer released or cancelled without ever dragging. */
    onLiftCancel?: () => void;
  };
}

export interface ChapterLanePointerDragHandle {
  cancel: () => void;
}

export function createExactlyOnceChapterDrop(
  onDrop: (target: ChapterLanePointerTarget) => void | Promise<void>,
): (target: ChapterLanePointerTarget | null) => Promise<void> {
  let committed = false;
  return async (target) => {
    if (committed || !target) return;
    committed = true;
    await onDrop(target);
  };
}

/**
 * Shared window-level pointer lifecycle for placed tiles and holding-popover
 * chips. Native HTML drag is deliberately absent: WebKit selection and drop
 * delivery no longer decide whether a chapter move commits.
 */
export function startChapterLanePointerDrag({
  pointerId,
  pointerType,
  startClientX,
  startClientY,
  sourceElement,
  grabOffsetX,
  resolveTarget,
  onDragStart,
  onDrop,
  onDragEnd,
  mobileTouch,
}: StartChapterLanePointerDragInput): ChapterLanePointerDragHandle {
  const threshold = pointerType === 'touch' ? 6 : 3;
  const mobileTouchEnabled = pointerType === 'touch' && Boolean(mobileTouch);
  const startedAt = Date.now();
  let dragging = false;
  let settled = false;
  let target: ChapterLanePointerTarget | null = null;
  let ghost: HTMLElement | null = null;
  let frame = 0;
  let pendingClientX = startClientX;
  let pendingClientY = startClientY;
  const sourceRect = sourceElement.getBoundingClientRect();
  const grabOffsetY = startClientY - sourceRect.top;
  const previousVisibility = sourceElement.style.visibility;
  const commitDrop = createExactlyOnceChapterDrop(onDrop);
  const autoscrollAxis = mobileTouch?.axis ?? 'x';
  let lifted = false;
  let menuTimer = mobileTouchEnabled
    ? window.setTimeout(() => {
        if (settled || dragging) return;
        if (mobileTouch?.holdBehavior === 'lift') {
          lifted = true;
          menuTimer = 0;
          mobileTouch.onLift?.();
          return;
        }
        settled = true;
        stopListening();
        cleanupVisuals();
        mobileTouch?.onMenu();
      }, MOBILE_PLANNING_CONTEXT_MENU_MS)
    : 0;

  const clearMenuTimer = () => {
    if (!menuTimer) return;
    window.clearTimeout(menuTimer);
    menuTimer = 0;
  };

  const paintDrag = () => {
    frame = 0;
    if (!ghost) return;
    ghost.style.transform = `translate3d(${pendingClientX - grabOffsetX}px, ${
      pendingClientY - grabOffsetY
    }px, 0)`;
    const scrollContainer = mobileTouch?.scrollContainer;
    if (scrollContainer) {
      const rect = scrollContainer.getBoundingClientRect();
      const delta =
        autoscrollAxis === 'y'
          ? mobilePlanningEdgeAutoscrollDelta({
              clientX: pendingClientY,
              left: rect.top,
              right: rect.bottom,
              scrollLeft: scrollContainer.scrollTop,
              maxScrollLeft: scrollContainer.scrollHeight - scrollContainer.clientHeight,
            })
          : mobilePlanningEdgeAutoscrollDelta({
              clientX: pendingClientX,
              left: rect.left,
              right: rect.right,
              scrollLeft: scrollContainer.scrollLeft,
              maxScrollLeft: scrollContainer.scrollWidth - scrollContainer.clientWidth,
            });
      if (delta !== 0) {
        if (autoscrollAxis === 'y') scrollContainer.scrollTop += delta;
        else scrollContainer.scrollLeft += delta;
      }
      target = resolveTarget(pendingClientX, pendingClientY);
      if (delta !== 0) frame = window.requestAnimationFrame(paintDrag);
      return;
    }
    target = resolveTarget(pendingClientX, pendingClientY);
  };
  const schedulePaint = (clientX: number, clientY: number) => {
    pendingClientX = clientX;
    pendingClientY = clientY;
    if (!frame) frame = window.requestAnimationFrame(paintDrag);
  };
  const createGhost = (clientX: number, clientY: number) => {
    ghost = sourceElement.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('draggable');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.classList.add('chapter-lane-pointer-ghost', 'is-dragging');
    ghost.style.width = `${sourceRect.width}px`;
    ghost.style.height = `${sourceRect.height}px`;
    document.body.appendChild(ghost);
    sourceElement.style.visibility = 'hidden';
    schedulePaint(clientX, clientY);
  };
  const unlockSelection = () => {
    document.documentElement.classList.remove('chapter-lane-pointer-dragging');
  };
  const stopListening = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleCancel);
    window.removeEventListener('pointerdown', handleAdditionalPointer, true);
    clearMenuTimer();
    unlockSelection();
  };
  const cleanupVisuals = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    ghost?.remove();
    ghost = null;
    sourceElement.style.visibility = previousVisibility;
  };
  const handleMove = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    const distance = Math.hypot(event.clientX - startClientX, event.clientY - startClientY);
    if (mobileTouchEnabled && !dragging && !lifted) {
      const intent = resolveMobilePlanningGesture({
        surface: 'card',
        elapsedMs: Date.now() - startedAt,
        distancePx: distance,
        pointerCount: 1,
      });
      if (intent === 'pan') {
        settled = true;
        stopListening();
        cleanupVisuals();
        return;
      }
      if (intent !== 'drag') return;
    }
    if (!dragging && distance < threshold) return;
    if (!dragging) {
      dragging = true;
      clearMenuTimer();
      document.documentElement.classList.add('chapter-lane-pointer-dragging');
      onDragStart();
      createGhost(event.clientX, event.clientY);
    }
    if (event.cancelable) event.preventDefault();
    window.getSelection()?.removeAllRanges();
    schedulePaint(event.clientX, event.clientY);
  };
  const handleUp = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    settled = true;
    if (dragging) {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      target = resolveTarget(event.clientX, event.clientY);
    }
    stopListening();
    if (!dragging) {
      cleanupVisuals();
      if (lifted) mobileTouch?.onLiftCancel?.();
      return;
    }
    const finalTarget = target;
    void Promise.resolve()
      .then(() => commitDrop(finalTarget))
      .finally(() => {
        cleanupVisuals();
        onDragEnd();
      });
  };
  const handleCancel = (event: PointerEvent) => {
    if (settled || event.pointerId !== pointerId) return;
    settled = true;
    stopListening();
    cleanupVisuals();
    if (dragging) onDragEnd();
    else if (lifted) mobileTouch?.onLiftCancel?.();
  };
  const handleAdditionalPointer = (event: PointerEvent) => {
    if (
      settled ||
      !mobileTouchEnabled ||
      event.pointerType !== 'touch' ||
      event.pointerId === pointerId
    ) {
      return;
    }
    settled = true;
    stopListening();
    cleanupVisuals();
    if (dragging) onDragEnd();
    else if (lifted) mobileTouch?.onLiftCancel?.();
  };

  window.addEventListener('pointermove', handleMove, { passive: false });
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleCancel);
  if (mobileTouchEnabled) window.addEventListener('pointerdown', handleAdditionalPointer, true);

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      stopListening();
      cleanupVisuals();
      if (dragging) onDragEnd();
    },
  };
}

interface CommitChapterLaneDropInput {
  nodeId: string;
  targetLaneId: string;
  targetOrder: number;
  orderField: ChapterOrderField;
  moveChapterOnTimeline: (
    nodeId: string,
    input: {
      orderField: ChapterOrderField;
      order: number;
      targetStorylineId?: string | null;
    },
  ) => Promise<unknown>;
}

/**
 * Persist one chapter drop using the same write ordering in both projections.
 * Primary/membership changes are applied before the final order patch so a
 * reroute cannot briefly snap back to the source lane.
 */
export async function commitChapterLaneDrop({
  nodeId,
  targetLaneId,
  targetOrder,
  orderField,
  moveChapterOnTimeline,
}: CommitChapterLaneDropInput): Promise<void> {
  if (!Number.isFinite(targetOrder)) throw new TypeError('chapter drop order must be finite');
  const targetStorylineId =
    targetLaneId === DEFAULT_STORYLINE_LANE_ID
      ? undefined
      : targetLaneId === UNAFFILIATED_STORYLINE_LANE_ID
        ? null
        : targetLaneId;
  await moveChapterOnTimeline(nodeId, {
    orderField,
    order: targetOrder,
    targetStorylineId,
  });
}
