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
  createdAt: string;
}

export interface BookNodeElementLink {
  id: string;
  nodeId: string;
  elementId: string;
}


