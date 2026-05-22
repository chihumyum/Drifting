/**
 * Shared geometry, zoom, and edge-style constants for SuperElementView.
 * Pixel sizes are in WORLD coordinates (pan + zoom transform is applied
 * by the canvas wrapper, not these constants).
 */

// Visual cell dimensions for the CATEGORY world. One element card occupies
// one cell; categories expand by adding cells. Taller cells = taller canvas;
// wider cells = more horizontal scrolling.
export const CELL_W = 96;
export const CELL_H = 56;

// Chapter band geometry, decoupled from category cells. Pills are FIXED
// width (so titles stay readable at any zoom); BAND_SLOT_PX controls how
// compact the band is — narrower slot = shorter timeline.
export const BAND_PILL_PX = 110;
export const BAND_SLOT_PX = 120;

// Group-header strip rendered between groups inside a category box. Pixels,
// NOT cells — so headers don't gobble a full card row when a category has
// only 1–2 groups. Rendered only when a category has 2+ named groups.
export const GROUP_HEADER_PX = 16;

// Inner padding around the card grid inside a category box.
export const CATEGORY_INNER_PAD_X = 3;
export const CATEGORY_INNER_PAD_Y_TOP = 8;
export const CATEGORY_INNER_PAD_Y_BOTTOM = 4;

// Zoom range — matches BottomTimeline's expanded-scale ergonomics.
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.0;

// EntityReference rows don't carry a free-form `kind`, so `origin` is the
// classification axis. Stroke style + color are derived from origin;
// visibility toggles via the header filter chips. If the schema grows a
// `kind` column later, swap this for a hash palette like StoryGraphView's
// colorForKind without touching the renderer.
export type EdgeOrigin = 'manual' | 'auto' | 'ai';

export interface EdgeOriginMeta {
  color: string;
  label: string;
  dash: string | null;
}

export const EDGE_ORIGIN_META: Record<EdgeOrigin, EdgeOriginMeta> = {
  manual: { color: 'hsl(var(--ink-2))', label: '手动', dash: null },
  auto: { color: 'hsl(var(--story-4))', label: '自动检测', dash: '4 3' },
  ai: { color: 'hsl(var(--story-2))', label: 'AI', dash: '1 3' },
};

export const EDGE_SELECTED_WIDTH = 2.2;
export const EDGE_DEFAULT_WIDTH = 1.2;
export const EDGE_HOVER_WIDTH = 1.8;

// localStorage key for per-project viewport (pan + zoom). Restoring on
// re-entry preserves the user's mental map of the iceberg.
export function viewportStorageKey(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return `super-element-view:viewport:${projectId}`;
}
