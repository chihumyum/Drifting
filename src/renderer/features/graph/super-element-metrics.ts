// Visual cell dimensions for CATEGORY world. Each element card occupies one
// cell. Categories expand by adding cells along whichever axis the
// group/element layout demands. Taller cells make the canvas taller; wider
// cells make horizontal scrolling more frequent.
export const CELL_W = 96;
export const CELL_H = 56;

// Chapter band geometry, decoupled from category cells. Pills are FIXED
// width (so a chapter title can read at any zoom); slot pitch controls
// how compact the overall band is — narrower slot = shorter timeline.
// Adjust BAND_SLOT_PX to compress / stretch the band without changing
// pill size.
export const BAND_PILL_PX = 110;
export const BAND_SLOT_PX = 120;

// Group-header strip rendered between groups inside a category box. Pixels,
// NOT cells — so headers don't gobble a full card row when the category
// only has 1–2 groups. Only rendered when a category has 2+ named groups
// (a single group's label is redundant with the category legend on top).
export const GROUP_HEADER_PX = 16;

// Inner Y padding around the card grid inside a category box. Top padding
// leaves room for the legend-straddles-border treatment to clear the first
// card; bottom padding mirrors it for symmetry. Horizontal symmetry is
// handled directly by the card's own +3/-6 inset against its colStep, so
// no CATEGORY_INNER_PAD_X is needed (the previous 3px left-only bias was
// the reason last-column cards covered the right border).
export const CATEGORY_INNER_PAD_Y_TOP = 8;
export const CATEGORY_INNER_PAD_Y_BOTTOM = 4;

// Visible horizontal gap between two adjacent category boxes. Each box
// renders inset by CATEGORY_GAP_X / 2 on its left and right edges; the
// solver still reserves widthCells whole cells per box, so the layout
// math stays integer-grid. Card cells inside compress slightly (colStep
// below) so the last column doesn't overflow the visible right border.
export const CATEGORY_GAP_X = CELL_W / 8;

/** Per-column horizontal pitch for cards inside a category box. The box's
 *  visible width is widthCells*CELL_W - CATEGORY_GAP_X; distributing that
 *  across widthCells columns keeps the first and last cards' inset against
 *  the box border symmetric (3px each side). */
export function cardColStep(widthCells: number): number {
  return (widthCells * CELL_W - CATEGORY_GAP_X) / widthCells;
}

// Zoom range; matches the BottomTimeline expanded-scale ergonomics.
export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.0;

// Inner padding inside the chapter band — kept small so storyline rows
// hug the band's top/bottom borders. The pills themselves carry a 3px
// inset against their lane edges (see pill `top = row + 3, height = CELL_H - 6`),
// which is enough breathing room without reserving a half-cell of empty
// band background. The outer gap to the nearest category strip is
// controlled separately by BAND_OUTER_PAD_PX / BAND_OUTER_RESERVE_CELLS.
export const BAND_PAD_CELLS = 0.25;
export const BAND_PAD_PX = (BAND_PAD_CELLS * CELL_H) / 2;

// Outer gap between the band and the nearest category strip — the band's
// visible top/bottom edges sit BAND_OUTER_PAD_PX inside the cell area the
// solver reserves. Result: ~28px of empty space above and below the band.
// Solver-side, we reserve an extra full cell of band-area; visually the
// band content offsets down by half a cell so the gap splits symmetrically.
export const BAND_OUTER_PAD_PX = CELL_H / 2;
export const BAND_OUTER_RESERVE_CELLS = 1;

// Breathing space around sticky-mode pan clamps. The bounds let the user
// scroll a few element-cards' worth past the band's x range and the
// category skyline's y extent — keeps the layout from feeling like it's
// caged against the viewport edges. Values are in cell units; they get
// multiplied by zoom at clamp time.
export const STICKY_PAD_CELLS_X = 3;
export const STICKY_PAD_CELLS_Y = 3;

export const EDGE_SELECTED_WIDTH = 2.4;
export const EDGE_DEFAULT_WIDTH = 1.6;
export const EDGE_HIT_WIDTH = 10;
