export interface GuideRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GuideViewport {
  width: number;
  height: number;
}

/** The ring stands this far outside what it points at. */
export const GUIDE_RING_OUTSET = 4;
/** The card keeps this far from the ring and from the window's edges. */
export const GUIDE_CARD_GAP = 10;
export const GUIDE_CARD_MARGIN = 8;

/** One box around everything a step points at; null when nothing of it shows. */
export function unionGuideRect(rects: readonly GuideRect[]): GuideRect | null {
  const shown = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (shown.length === 0) return null;
  const left = Math.min(...shown.map((rect) => rect.left));
  const top = Math.min(...shown.map((rect) => rect.top));
  const right = Math.max(...shown.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...shown.map((rect) => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * The ring around a target: a little larger, round targets stay round, and
 * never past the window's edge (the tab rows run along the top of the window).
 */
export function guideRingRect(target: GuideRect, viewport?: GuideViewport): GuideRect & { radius: number } {
  const edge = 1;
  const left = Math.max(edge, target.left - GUIDE_RING_OUTSET);
  const top = Math.max(edge, target.top - GUIDE_RING_OUTSET);
  const right = Math.min(viewport ? viewport.width - edge : Infinity, target.left + target.width + GUIDE_RING_OUTSET);
  const bottom = Math.min(viewport ? viewport.height - edge : Infinity, target.top + target.height + GUIDE_RING_OUTSET);
  const rect = { left, top, width: right - left, height: bottom - top };
  const round = Math.abs(target.width - target.height) <= 2 && target.width <= 40;
  return { ...rect, radius: round ? rect.height / 2 : Math.min(12, rect.height / 2) };
}

/**
 * Where the card goes: under the ring when it fits, else above it, else
 * beside it on the roomier side; always inside the window. Left edges line
 * up with the ring unless that would run off the window.
 */
export function placeGuideCard(
  ring: GuideRect,
  card: { width: number; height: number },
  viewport: GuideViewport,
): { left: number; top: number } {
  const clampLeft = (left: number) =>
    Math.max(GUIDE_CARD_MARGIN, Math.min(left, viewport.width - GUIDE_CARD_MARGIN - card.width));
  const clampTop = (top: number) =>
    Math.max(GUIDE_CARD_MARGIN, Math.min(top, viewport.height - GUIDE_CARD_MARGIN - card.height));
  const below = ring.top + ring.height + GUIDE_CARD_GAP;
  if (below + card.height + GUIDE_CARD_MARGIN <= viewport.height) {
    return { left: clampLeft(ring.left), top: below };
  }
  const above = ring.top - GUIDE_CARD_GAP - card.height;
  if (above >= GUIDE_CARD_MARGIN) {
    return { left: clampLeft(ring.left + ring.width - card.width), top: above };
  }
  const spaceRight = viewport.width - (ring.left + ring.width);
  const left = spaceRight >= ring.left
    ? ring.left + ring.width + GUIDE_CARD_GAP
    : ring.left - GUIDE_CARD_GAP - card.width;
  return { left: clampLeft(left), top: clampTop(ring.top) };
}
