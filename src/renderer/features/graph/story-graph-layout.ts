import type { BookNode } from '../../domain/book-node';
import type { Storyline } from '../../domain/storyline';

export const GRAPH_CONFIG = {
  // Wider grid units than BottomTimeline — fullscreen has room to breathe.
  GRID_UNIT: 32,
  // Tile width in grid units; same convention as BottomTimeline.
  TILE_WIDTH_UNITS: 4,
  // Bigger tiles than Phase 3: StoryGraphView is intended to grow into the
  // primary editing surface for inter-node relationship graphs, so each
  // tile needs room to host more attribute UI later.
  TILE_HEIGHT: 96,
  // Default storyline row height. Generous so the gaps between rows can
  // host relationship edges + inline UI without the layout feeling
  // cramped. Per-storyline overrides via TRACK_OVERRIDES below grow the
  // row dynamically (e.g. when the user expands a storyline to author
  // its relationship graph).
  TRACK_HEIGHT: 160,
  // Per-storyline track-height overrides keyed by storyline id. Reserved
  // for the future "expand this row to author relationships" affordance;
  // an empty record now means every row uses TRACK_HEIGHT.
  RAIL_WIDTH: 158,
  AXIS_HEIGHT: 32,
  FULL_BOOK_LANE_HEIGHT: 32,
  CANVAS_PADDING_X: 24,
  // Runway (grid units) the canvas extends past the furthest chapter / marker
  // / act, so pins can be dragged and acts planned beyond the last chapter.
  RUNWAY_UNITS: 8,
  // Trailing pixel pad so the right-most pin's label (which flows to the RIGHT
  // of the pin) isn't clipped at the canvas edge.
  LABEL_PAD: 220,
};

// BookNode is a discriminated union; `extends` doesn't accept unions, so we
// use an intersection. PositionedNode keeps either variant intact and adds
// the StoryGraphView's per-node layout fields on top.
export type PositionedNode = BookNode & {
  storyline: Storyline | null;
  storylines: Storyline[];
  rowIndex: number;
  x: number; // tile left, in canvas pixels (already includes padding)
  y: number; // track center, in canvas pixels
};

export type StoryGraphLane = { id: string; name: string; color: string; synthetic: boolean };
export const EMPTY_POSITIONED_NODES: readonly PositionedNode[] = [];

/** Group primary visual placement once; secondary memberships still belong
 * to the independent storyline adjacency/count projection. Keep input order
 * and node identity for card refs, selection and drag coordinates. */
export function groupPositionedNodesByRow(nodes: readonly PositionedNode[]) {
  const rows = new Map<number, PositionedNode[]>();
  for (const node of nodes) {
    const row = rows.get(node.rowIndex);
    if (row) row.push(node);
    else rows.set(node.rowIndex, [node]);
  }
  return rows;
}
