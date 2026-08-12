import type { PaperReveal } from './usePaperPinch';

export interface PaperClusterPreview {
  target: Exclude<PaperReveal, 'focused'>;
  progress: number;
}

const TAP_SLOP = 5;
const DEFAULT_PANEL_EXTENT = 0.3;
const MIN_DOCK_EXTENT = 0.12;
export const PAPER_CLUSTER_QUICK_SWITCH_STEP = 44;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function paperClusterPreview(
  start: PaperReveal,
  deltaY: number,
  viewportHeight: number,
  startExtent = DEFAULT_PANEL_EXTENT,
): PaperClusterPreview {
  const height = Math.max(1, viewportHeight);
  if (start === 'focused') {
    return {
      target: deltaY < 0 ? 'bottom' : 'top',
      // The exposed panel edge follows the finger one CSS pixel for one CSS
      // pixel: visibleExtent = progress * DEFAULT_PANEL_EXTENT.
      progress: clamp(Math.abs(deltaY) / height / DEFAULT_PANEL_EXTENT),
    };
  }

  const closingDelta = start === 'bottom' ? Math.max(0, deltaY) : Math.max(0, -deltaY);
  const extent = Math.max(0, startExtent - closingDelta / height);
  return {
    target: start,
    progress: startExtent > 0 ? clamp(extent / startExtent) : 0,
  };
}

/**
 * Returns null for a tap. The destination is derived from pointer-up
 * coordinates instead of React render state so fast native drags still dock
 * correctly even when WebKit coalesces intermediate pointermove events.
 */
export function paperClusterDestination(
  start: PaperReveal,
  deltaY: number,
  viewportHeight: number,
  startExtent = DEFAULT_PANEL_EXTENT,
): PaperReveal | null {
  if (Math.abs(deltaY) <= TAP_SLOP) return null;
  const preview = paperClusterPreview(start, deltaY, viewportHeight, startExtent);
  const extent = preview.progress * (start === 'focused' ? DEFAULT_PANEL_EXTENT : startExtent);
  return extent >= MIN_DOCK_EXTENT ? preview.target : 'focused';
}

/** A short pill drag can cross several papers without dragging a full page width. */
export function paperClusterQuickSwitchIndex(
  originIndex: number,
  deltaX: number,
  paperCount: number,
): number {
  if (paperCount <= 0) return -1;
  const boundedOrigin = Math.max(0, Math.min(paperCount - 1, originIndex));
  const offset = Math.round(-deltaX / PAPER_CLUSTER_QUICK_SWITCH_STEP);
  return Math.max(0, Math.min(paperCount - 1, boundedOrigin + offset));
}
