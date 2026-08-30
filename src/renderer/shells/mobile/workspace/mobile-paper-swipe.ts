import type { MobileWorkspaceUiState } from './mobile-workspace-controller';

export const MOBILE_PAPER_SWIPE_AXIS_LOCK_PX = 8;
export const MOBILE_PAPER_SWIPE_AXIS_RATIO = 1.2;
export const MOBILE_PAPER_SWIPE_VELOCITY_PX_PER_MS = 0.45;
export const MOBILE_PAPER_SWIPE_HOLD_CANCEL_MS = 180;

export type MobilePaperRailState = 'toc' | 'comments' | null;

export interface MobilePaperSwipeEnvironment {
  workspace: MobileWorkspaceUiState;
  activeRail: MobilePaperRailState;
  selectionCollapsed: boolean;
  composing: boolean;
}

export interface MobilePaperSwipeDecisionInput {
  deltaX: number;
  deltaY: number;
  durationMs: number;
  viewportWidth: number;
  originIndex: number;
  paperCount: number;
}

export interface MobilePaperSwipeDecision {
  axis: 'pending' | 'vertical' | 'horizontal';
  committed: boolean;
  direction: -1 | 0 | 1;
  targetIndex: number;
  distanceThreshold: number;
}

const EXCLUDED_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  'canvas',
  '[role="button"]',
  '[role="link"]',
  '[role="slider"]',
  '[role="tab"]',
  '[data-mobile-paper-swipe="exclude"]',
  '.btl',
  '.planner-wrap',
  '.review-card',
  '.editor__toc-rail',
].join(',');

const ALWAYS_EXCLUDED_SELECTOR = [
  'input',
  'textarea',
  'select',
  'summary',
  'canvas',
  '[role="slider"]',
  '[role="tab"]',
  '[data-mobile-paper-swipe="exclude"]',
  '.btl',
  '.planner-wrap',
  '.review-card',
  '.editor__toc-rail',
].join(',');

export function mobilePaperSwipeDistanceThreshold(viewportWidth: number): number {
  const width = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  return Math.max(72, Math.min(96, width * 0.22));
}

export function canStartMobilePaperSwipe({
  workspace,
  activeRail,
  selectionCollapsed,
  composing,
}: MobilePaperSwipeEnvironment): boolean {
  return (
    workspace.surface.kind === 'paper' &&
    workspace.paperMode.kind === 'read' &&
    workspace.overlay === 'none' &&
    workspace.transient.kind === 'none' &&
    workspace.keyboard === 'closed' &&
    activeRail === null &&
    selectionCollapsed &&
    !composing
  );
}

export function resolveMobilePaperSwipe({
  deltaX,
  deltaY,
  durationMs,
  viewportWidth,
  originIndex,
  paperCount,
}: MobilePaperSwipeDecisionInput): MobilePaperSwipeDecision {
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);
  const distanceThreshold = mobilePaperSwipeDistanceThreshold(viewportWidth);
  const boundedOrigin = Math.max(0, Math.min(Math.max(0, paperCount - 1), originIndex));
  const base = {
    committed: false,
    direction: 0 as const,
    targetIndex: boundedOrigin,
    distanceThreshold,
  };

  if (Math.max(absoluteX, absoluteY) < MOBILE_PAPER_SWIPE_AXIS_LOCK_PX) {
    return { axis: 'pending', ...base };
  }
  if (absoluteX < absoluteY * MOBILE_PAPER_SWIPE_AXIS_RATIO) {
    return { axis: 'vertical', ...base };
  }

  const direction: -1 | 1 = deltaX < 0 ? 1 : -1;
  const velocity = absoluteX / Math.max(1, durationMs);
  const wantsCommit =
    absoluteX >= distanceThreshold || velocity >= MOBILE_PAPER_SWIPE_VELOCITY_PX_PER_MS;
  const targetIndex = Math.max(0, Math.min(Math.max(0, paperCount - 1), boundedOrigin + direction));
  const committed = wantsCommit && targetIndex !== boundedOrigin;
  return {
    axis: 'horizontal',
    committed,
    direction: committed ? direction : 0,
    targetIndex: committed ? targetIndex : boundedOrigin,
    distanceThreshold,
  };
}

export function mobilePaperSwipeTargetIsExcluded(
  target: EventTarget | null,
  row: HTMLElement,
  allowInteractiveStart = false,
): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(allowInteractiveStart ? ALWAYS_EXCLUDED_SELECTOR : EXCLUDED_SELECTOR)) {
    return true;
  }

  for (let element: Element | null = target; element && element !== row; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element);
    const scrollable =
      element.scrollWidth > element.clientWidth + 1 &&
      (style.overflowX === 'auto' || style.overflowX === 'scroll');
    if (scrollable) return true;
  }
  return false;
}
