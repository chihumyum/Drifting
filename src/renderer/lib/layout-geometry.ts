export type SidebarSide = 'left' | 'right';

const SIDEBAR_MIN_WIDTH: Record<SidebarSide, number> = {
  left: 140,
  right: 200,
};

const SIDEBAR_MAX_VIEWPORT_RATIO: Record<SidebarSide, number> = {
  left: 0.3,
  right: 0.6,
};

// Keep the prose column usable when both persisted sidebars are restored on a
// narrower desktop window. The mobile shell has its own navigation model and
// does not render these sidebars.
export const MIN_DESKTOP_CONTENT_WIDTH = 420;

export interface DimensionBounds {
  min: number;
  max: number;
}

export function clampDimension(value: number, { min, max }: DimensionBounds): number {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin;
  if (!Number.isFinite(value)) return safeMin;
  return Math.min(safeMax, Math.max(safeMin, value));
}

export function parsePersistedDimension(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function sidebarWidthBounds(
  side: SidebarSide,
  viewportWidth: number,
  oppositeOpenWidth: number,
): DimensionBounds {
  const min = SIDEBAR_MIN_WIDTH[side];
  const safeViewport = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const safeOpposite = Number.isFinite(oppositeOpenWidth)
    ? Math.max(0, oppositeOpenWidth)
    : 0;
  const ratioMax = safeViewport * SIDEBAR_MAX_VIEWPORT_RATIO[side];
  const contentPreservingMax = safeViewport - safeOpposite - MIN_DESKTOP_CONTENT_WIDTH;
  return { min, max: Math.max(min, Math.min(ratioMax, contentPreservingMax)) };
}

export function clampSidebarWidth(
  width: number,
  side: SidebarSide,
  viewportWidth: number,
  oppositeOpenWidth: number,
): number {
  return clampDimension(width, sidebarWidthBounds(side, viewportWidth, oppositeOpenWidth));
}

export function verticalDockBounds(
  containerHeight: number,
  minDockHeight: number,
  minContentHeight: number,
): DimensionBounds {
  const min = Math.max(0, minDockHeight);
  const safeContainer = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;
  const safeContent = Number.isFinite(minContentHeight) ? Math.max(0, minContentHeight) : 0;
  return { min, max: Math.max(min, safeContainer - safeContent) };
}
