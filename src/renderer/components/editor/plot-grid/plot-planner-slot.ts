import { useSyncExternalStore } from 'react';

// The plot planner lives in the dock under the paper, which it shares with
// the Bottom Timeline. The desktop workspace owns that place; the focused
// node editor, which owns the grid's content and persistence, portals its
// planner into it. One place, so one element.
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Ref callback for the element the planner is portaled into. */
export function setPlotPlannerSlot(element: HTMLElement | null): void {
  if (slot === element) return;
  slot = element;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The element to portal the plot planner into, while the dock shows it. */
export function usePlotPlannerSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
