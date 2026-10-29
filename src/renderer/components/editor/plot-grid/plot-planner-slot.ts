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

// A planner leaves when its chapter stops being in front, often while the
// panel still shows (sliding shut, or until the next chapter's planner
// arrives). It leaves a still, inert copy of itself, scroll included, so the
// grid goes with the panel instead of blinking out; the next planner, or the
// panel closing, takes the copy away.
const GHOST_CLASS = 'plot-planner--ghost';

/** Called by a departing planner, before its element is removed. */
export function leavePlotPlannerGhost(planner: HTMLElement | null): void {
  if (!slot || !planner || planner.parentElement !== slot) return;
  clearPlotPlannerGhost();
  const ghost = planner.cloneNode(true) as HTMLElement;
  ghost.classList.add(GHOST_CLASS);
  ghost.inert = true;
  ghost.setAttribute('aria-hidden', 'true');
  slot.append(ghost);
  const from = planner.querySelector<HTMLElement>('.planner-wrap');
  const to = ghost.querySelector<HTMLElement>('.planner-wrap');
  if (from && to) {
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
  }
}

/** Called by an arriving planner. */
export function clearPlotPlannerGhost(): void {
  slot?.querySelectorAll(`:scope > .${GHOST_CLASS}`).forEach((ghost) => ghost.remove());
}
