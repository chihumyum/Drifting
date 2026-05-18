export interface BookNode {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  // Pure sortable integer for reading order. Drives book-order views.
  bookOrder: number;
  // Author-defined position on the narrative timeline (independent of
  // bookOrder so flashbacks / non-linear chronology can be expressed).
  // null = not yet placed on the narrative axis.
  narrativeOrder: number | null;
  storyStageId: string | null;
  // null for "drift" nodes — free-floating notes/inspiration that don't
  // belong to any storyline and don't appear in timelines or graph view.
  mainStorylineId: string | null;
  position: GraphViewNodePosition;
  /**
   * Materialized word count derived from this node's content.
   * Counted as: CJK chars + non-CJK whitespace-separated tokens with
   * at least one alphanumeric (matches MS Word's "字数").
   * 0 for never-edited nodes; backfilled on first save after open.
   */
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphViewNodePosition {
  x: number;
  y: number;
}

export interface BookNodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string;
  // User-defined category — drives GraphView filter chips. null when the
  // author hasn't tagged it; the chips list just whatever distinct values
  // currently exist in the data.
  kind: string | null;
  weight: number;
  isDirected: boolean; // Default true if undefined
  createdAt: string;
  updatedAt: string;
  // Freeform Styling & Geometry
  style?: {
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    strokeDasharray?: string;
    filter?: string;
  };
  controlPointOffset?: { x: number; y: number }; // Offset from the midpoint for curvature
  sourceAnchor?: { x: number; y: number }; // Relative to node top-left
  targetAnchor?: { x: number; y: number }; // Relative to node top-left
}
