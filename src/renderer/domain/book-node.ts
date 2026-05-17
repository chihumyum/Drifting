export interface BookNode {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  start: number; // Position on timeline (chapter order / story time start)
  end: number; // Timeline end position
  storyStageId: string | null;
  mainStorylineId: string;
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

export interface NodeElementBacklink {
  nodeId: string;
  elementId: string;
}
