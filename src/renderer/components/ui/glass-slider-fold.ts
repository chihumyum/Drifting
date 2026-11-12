/**
 * Subpixel layout rounding on fractional-DPI displays (such as 125% or 150%
 * Windows scaling) can shift `getBoundingClientRect().width` by a fraction of a
 * CSS pixel when a slider's hidden measurement row remounts between its
 * side-by-side and collapsed shells, or when sibling controls move horizontally.
 *
 * Ignoring sub-half-pixel measurement noise and separating the fold and unfold
 * thresholds keeps a narrow toolbar from oscillating between the two states in
 * a synchronous `useLayoutEffect` loop (React error #185).
 */
export const NATURAL_WIDTH_EPSILON = 0.5;
export const SLIDER_FOLD_SLACK = 0.5;
export const SLIDER_UNFOLD_SLACK = 4;

export function shouldReportNaturalWidth(previous: number, next: number): boolean {
  if (!(next > 0)) return false;
  if (!(previous > 0)) return true;
  return Math.abs(next - previous) >= NATURAL_WIDTH_EPSILON;
}

export function nextSliderCollapsed(
  collapsed: boolean,
  naturalWidth: number,
  room: number,
): boolean {
  return collapsed
    ? naturalWidth > room - SLIDER_UNFOLD_SLACK
    : naturalWidth > room + SLIDER_FOLD_SLACK;
}
