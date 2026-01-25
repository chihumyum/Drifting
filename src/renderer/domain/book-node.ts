

export interface BookNode {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  start: number;                     // Position on timeline (chapter order / story time start)
  end: number;                // Timeline end position
  storyStageId: string | null;
  mainStorylineId: string;
  storylineIds: string[];  // Associated storylines, could be multiple
  tagIds: string[];       // Tags associated with this node
  position: GraphViewNodePosition;
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

