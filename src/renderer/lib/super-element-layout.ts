/**
 * SuperElementView layout solver.
 *
 * Places category boxes onto a 2D grid that straddles a horizontal chapter
 * band. The band sits at gridY in [0, bandHeightCells); categories live
 * above (gridY < 0) and below (gridY >= bandHeightCells). The solver is a
 * double-sided skyline / strip packer with an area-balance objective so the
 * canvas stays visually symmetric — the "iceberg" shape the design calls for.
 *
 * Coordinates are in GRID CELLS, not pixels. The view layer multiplies by
 * cell pixel dimensions at render time. Both axes can extend in either
 * direction; x is unbounded, y is bounded below by the deepest placement on
 * each side.
 *
 * Cell semantics:
 *   • A category at (gridX, gridY) with (w, h) occupies the rectangle
 *     [gridX, gridX + w) × [gridY, gridY + h).
 *   • On the TOP side, gridY is NEGATIVE; the category's bottom row is at
 *     gridY + h - 1, which is also negative. h cells stack upward from row
 *     -1 (the row immediately above the band).
 *   • On the BOTTOM side, gridY >= bandHeightCells; the top row sits flush
 *     against the band's bottom edge.
 *
 * Pinned categories are anchored by the user (drag + drop); the solver
 * treats them as obstacles. Auto categories are sorted by area descending
 * (First-Fit Decreasing) and slotted around the obstacles.
 */

export type LayoutSide = 'top' | 'bottom';

export interface LayoutInput {
  id: string;
  /** Width in grid cells. Must be >= 1. */
  widthCells: number;
  /** Height in grid cells. Must be >= 1. */
  heightCells: number;
  /** User-pinned anchor; when set, solver places category here verbatim. */
  pinned?: {
    /** Leftmost cell column. */
    gridX: number;
    /**
     * Topmost cell row. Negative = top strip, >= bandHeightCells = bottom
     * strip. Crossing the band is invalid; the solver clamps to the nearer
     * strip if needed.
     */
    gridY: number;
  };
}

export interface LayoutPlacement {
  id: string;
  /** Leftmost cell column the category occupies. */
  gridX: number;
  /** Topmost cell row the category occupies. */
  gridY: number;
  side: LayoutSide;
}

export interface LayoutResult {
  placements: LayoutPlacement[];
  /**
   * Cell-coordinate bounding box around everything in the layout (including
   * the band). The view sizes its canvas to this.
   */
  bounds: {
    minX: number;
    maxX: number;
    minY: number; // most negative top row
    maxY: number; // most positive bottom row (exclusive)
  };
}

export interface LayoutOptions {
  /**
   * Height of the chapter band in cells. The band sits at y in [0, bandHeightCells).
   * Use 0 if you don't want a band.
   */
  bandHeightCells: number;
  /**
   * Solver biases placement around this column (default 0) so the first
   * categories land near the canvas origin instead of drifting off-screen.
   */
  anchorX?: number;
  /**
   * Brute-force search range. The solver evaluates candidate gridX values
   * in [anchorX - searchExtent, anchorX + searchExtent]. Larger = better
   * packing but slower. 64 handles ~50 categories cleanly; bump if your
   * project has 200+ categories.
   */
  searchExtent?: number;
  /**
   * Side-balance weight. 0 = greedy lowest-peak only (compact but lopsided).
   * 1 = balance area between top/bottom (the iceberg look). Higher pushes
   * harder toward symmetry at the cost of vertical compactness.
   */
  balanceAlpha?: number;
}

/**
 * Sparse 1D skyline. heights[x] = number of cells already occupied at column
 * x on this side, measured perpendicular to the band. Columns absent from
 * the map are at height 0 (empty).
 */
class Skyline {
  private heights = new Map<number, number>();

  height(x: number): number {
    return this.heights.get(x) ?? 0;
  }

  /** Max height across [x, x + w). */
  peak(x: number, w: number): number {
    let p = 0;
    for (let dx = 0; dx < w; dx++) {
      const h = this.heights.get(x + dx) ?? 0;
      if (h > p) p = h;
    }
    return p;
  }

  /** Raise [x, x + w) to at least `newHeight`. */
  occupy(x: number, w: number, newHeight: number): void {
    for (let dx = 0; dx < w; dx++) {
      const cur = this.heights.get(x + dx) ?? 0;
      if (newHeight > cur) this.heights.set(x + dx, newHeight);
    }
  }
}

interface BestSlot {
  gridX: number;
  /** Peak skyline height across the candidate range — i.e. how many cells
   *  this category will be lifted off the band on its near edge. */
  liftCells: number;
  /** Tiebreak metric — distance from anchorX. Lower wins on ties. */
  distance: number;
}

/**
 * Scan candidate gridX values, return the position that minimises lift
 * (skyline peak) with a tiebreak on distance from the anchor.
 */
function findBestSlot(
  skyline: Skyline,
  width: number,
  anchorX: number,
  searchExtent: number,
): BestSlot {
  // Bias the search so the category's CENTER lands near anchorX rather
  // than its left edge — gives a more pleasing visual when the first
  // categories drop in near the canvas origin.
  const centerBias = anchorX - Math.floor(width / 2);
  let best: BestSlot = {
    gridX: centerBias,
    liftCells: Number.POSITIVE_INFINITY,
    distance: Number.POSITIVE_INFINITY,
  };
  for (let x = centerBias - searchExtent; x <= centerBias + searchExtent; x++) {
    const lift = skyline.peak(x, width);
    const distance = Math.abs(x - centerBias);
    if (
      lift < best.liftCells ||
      (lift === best.liftCells && distance < best.distance)
    ) {
      best = { gridX: x, liftCells: lift, distance };
    }
  }
  return best;
}

/**
 * Main entry point. Pure function — given the same input it returns the
 * same placements. Safe to call on every render, but cache if your category
 * set is stable.
 */
export function solveSuperElementLayout(
  inputs: LayoutInput[],
  options: LayoutOptions,
): LayoutResult {
  const { bandHeightCells } = options;
  const anchorX = options.anchorX ?? 0;
  const searchExtent = options.searchExtent ?? 64;
  const balanceAlpha = options.balanceAlpha ?? 1.0;

  const topSky = new Skyline();
  const bottomSky = new Skyline();

  // Pinned obstacles get installed first so the auto pass can route around
  // them. We snap pinned categories that accidentally straddle the band to
  // the nearer strip; the UI shouldn't ever produce such input, but the
  // solver is robust to it.
  const pinned: LayoutInput[] = [];
  const auto: LayoutInput[] = [];
  for (const cat of inputs) {
    if (cat.pinned) pinned.push(cat);
    else auto.push(cat);
  }

  const placements: LayoutPlacement[] = [];

  // Track placed area per side to drive the balance objective.
  let topArea = 0;
  let bottomArea = 0;

  for (const cat of pinned) {
    const px = cat.pinned!.gridX;
    let py = cat.pinned!.gridY;
    const w = cat.widthCells;
    const h = cat.heightCells;
    let side: LayoutSide;

    // Disallow band crossings — snap into nearest strip.
    if (py + h > 0 && py < bandHeightCells) {
      // Crossing or fully inside band; pick by which side py is closer to.
      if (py < bandHeightCells / 2) {
        py = -h; // top strip, bottom row at -1
        side = 'top';
      } else {
        py = bandHeightCells; // bottom strip, top row at bandHeightCells
        side = 'bottom';
      }
    } else if (py < 0) {
      side = 'top';
    } else {
      side = 'bottom';
    }

    placements.push({ id: cat.id, gridX: px, gridY: py, side });
    const area = w * h;
    if (side === 'top') {
      // Top skyline height = |topRow of category|; we treat the whole x range
      // as occupied up to that level, even if there's a gap below the pinned
      // category. That gap is the user's choice; the solver doesn't reclaim it.
      topSky.occupy(px, w, Math.abs(py));
      topArea += area;
    } else {
      // Bottom skyline height = bottomRow - (bandHeightCells - 1) = py + h - bandHeightCells.
      bottomSky.occupy(px, w, py + h - bandHeightCells);
      bottomArea += area;
    }
  }

  // FFD: pack the biggest boxes first. Stable tiebreak on id so the layout
  // is deterministic when areas tie.
  auto.sort((a, b) => {
    const areaDelta = b.widthCells * b.heightCells - a.widthCells * a.heightCells;
    if (areaDelta !== 0) return areaDelta;
    return a.id.localeCompare(b.id);
  });

  for (const cat of auto) {
    const w = cat.widthCells;
    const h = cat.heightCells;
    const area = w * h;

    const topSlot = findBestSlot(topSky, w, anchorX, searchExtent);
    const botSlot = findBestSlot(bottomSky, w, anchorX, searchExtent);

    // Effective vertical extent after placing on each side. Add a balance
    // penalty proportional to how much this would unbalance the strips.
    const topExtentAfter = topSlot.liftCells + h;
    const botExtentAfter = botSlot.liftCells + h;
    const topImbalance = Math.max(0, topArea + area - bottomArea);
    const botImbalance = Math.max(0, bottomArea + area - topArea);
    const topScore = topExtentAfter + balanceAlpha * Math.sqrt(topImbalance);
    const botScore = botExtentAfter + balanceAlpha * Math.sqrt(botImbalance);

    const useTop =
      topScore < botScore ||
      // Tiebreak: pick the side with less area so far. Deterministic when
      // both sides are empty (initial categories alternate top/bottom).
      (topScore === botScore && topArea <= bottomArea);

    if (useTop) {
      const topRow = -(topSlot.liftCells + h);
      placements.push({ id: cat.id, gridX: topSlot.gridX, gridY: topRow, side: 'top' });
      topSky.occupy(topSlot.gridX, w, topSlot.liftCells + h);
      topArea += area;
    } else {
      const topRow = bandHeightCells + botSlot.liftCells;
      placements.push({ id: cat.id, gridX: botSlot.gridX, gridY: topRow, side: 'bottom' });
      bottomSky.occupy(botSlot.gridX, w, botSlot.liftCells + h);
      bottomArea += area;
    }
  }

  // Re-order placements to match the original input order so the view layer
  // can do a stable map lookup; FFD reordering is purely internal.
  const byId = new Map(placements.map((p) => [p.id, p]));
  const orderedPlacements = inputs.map((cat) => byId.get(cat.id)!).filter(Boolean);

  // Bounds — include the band on the y axis even when no categories were
  // placed, so the canvas always sizes to at least the band.
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = 0;
  let maxY = bandHeightCells;
  for (const p of orderedPlacements) {
    const cat = inputs.find((c) => c.id === p.id)!;
    minX = Math.min(minX, p.gridX);
    maxX = Math.max(maxX, p.gridX + cat.widthCells);
    minY = Math.min(minY, p.gridY);
    maxY = Math.max(maxY, p.gridY + cat.heightCells);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }

  return { placements: orderedPlacements, bounds: { minX, maxX, minY, maxY } };
}
