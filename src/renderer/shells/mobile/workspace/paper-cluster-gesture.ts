import type { PaperReveal } from './usePaperPinch';

export interface PaperClusterPreview {
  target: Exclude<PaperReveal, 'focused'>;
  progress: number;
}

const PREVIEW_DISTANCE = 150;
const TAP_SLOP = 5;
const DOCK_THRESHOLD = 0.4;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function paperClusterPreview(start: PaperReveal, deltaY: number): PaperClusterPreview {
  if (start === 'focused') {
    return {
      target: deltaY < 0 ? 'bottom' : 'top',
      progress: clamp(Math.abs(deltaY) / PREVIEW_DISTANCE),
    };
  }

  const closingDelta = start === 'bottom' ? Math.max(0, deltaY) : Math.max(0, -deltaY);
  return {
    target: start,
    progress: clamp(1 - closingDelta / PREVIEW_DISTANCE),
  };
}

/**
 * Returns null for a tap. The destination is derived from pointer-up
 * coordinates instead of React render state so fast native drags still dock
 * correctly even when WebKit coalesces intermediate pointermove events.
 */
export function paperClusterDestination(start: PaperReveal, deltaY: number): PaperReveal | null {
  if (Math.abs(deltaY) <= TAP_SLOP) return null;
  const preview = paperClusterPreview(start, deltaY);
  return preview.progress >= DOCK_THRESHOLD ? preview.target : 'focused';
}
