import { unionGuideRect, type GuideRect } from './tour-geometry';
import type { GuideStep } from './workspace-tour';

/** A rect of an element that is on screen and reachable (not under an inert Super View). */
function shownRect(element: Element): GuideRect | null {
  if (element.closest('[inert], [aria-hidden="true"]')) return null;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  if (box.right <= 0 || box.bottom <= 0 || box.left >= window.innerWidth || box.top >= window.innerHeight) {
    return null;
  }
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

function resolve(targets: readonly string[], pick: GuideStep['pick']): GuideRect | null {
  const rects: GuideRect[] = [];
  for (const selector of targets) {
    for (const element of document.querySelectorAll(selector)) {
      const rect = shownRect(element);
      if (!rect) continue;
      if (pick === 'first') return rect;
      rects.push(rect);
    }
  }
  return unionGuideRect(rects);
}

export interface GuideTarget {
  rect: GuideRect;
  bodyKey: string;
}

/**
 * Where a step points now and what it says there: its control when that is
 * on screen, else its fallback (a closed sidebar's toggle), else nothing.
 */
export function resolveGuideTarget(step: GuideStep): GuideTarget | null {
  const rect = resolve(step.targets, step.pick);
  if (rect) return { rect, bodyKey: step.bodyKey };
  if (!step.fallback) return null;
  const fallback = resolve(step.fallback.targets, 'first');
  return fallback ? { rect: fallback, bodyKey: step.fallback.bodyKey } : null;
}
