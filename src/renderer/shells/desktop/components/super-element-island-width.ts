/** The island's share of the canvas while it holds an editor: dragged, 15–75%. */
export const ISLAND_WIDTH_MIN = 0.15;
export const ISLAND_WIDTH_MAX = 0.75;
export const ISLAND_WIDTH_DEFAULT = 0.38;
const WIDTH_KEY = 'super-element-view:island-width';

export function clampIslandWidth(ratio: number): number {
  if (!Number.isFinite(ratio)) return ISLAND_WIDTH_DEFAULT;
  return Math.min(ISLAND_WIDTH_MAX, Math.max(ISLAND_WIDTH_MIN, ratio));
}

export function readIslandWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored ? clampIslandWidth(stored) : ISLAND_WIDTH_DEFAULT;
  } catch {
    return ISLAND_WIDTH_DEFAULT;
  }
}

export function storeIslandWidth(ratio: number) {
  try {
    localStorage.setItem(WIDTH_KEY, ratio.toFixed(3));
  } catch {
    /* private mode or quota: the width just isn't remembered */
  }
}
