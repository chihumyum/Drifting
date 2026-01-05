import type { NodeEdgeKind } from '../schema/book_node';

export interface BookNodePosition {
  x: number | null;
  y: number | null;
}

export interface BookNode {
  id: string;
  projectId: string;
  title: string;
  start: number;                     // Position on timeline (chapter order / story time start)
  end: number | null;                // Timeline end position (null = use default width)
  summary: string | null;
  storyStageId: string | null;       // FK to story_stage, nullable
  position: BookNodePosition;
  createdAt: string;
  updatedAt: string;
}

// DEPRECATED: Old structure kept for backward compatibility
export interface BookNodeTag {
  id: string;
  nodeId: string;
  name: string;
}

export interface BookNodeEdge {
  id: string;
  projectId: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: NodeEdgeKind;
  label: string | null;
  weight: number;
  isDirected?: boolean; // Default true if undefined
  createdAt: string;
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

export interface BookNodeElementLink {
  id: string;
  nodeId: string;
  elementId: string;
}


