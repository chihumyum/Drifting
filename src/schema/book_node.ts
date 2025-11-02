export type NodeType = 'chapter' | 'scene' | 'beat';
export type NodeStatus = 'draft' | 'in_progress' | 'complete' | 'archived';
export type NodeEdgeKind = 'chronology' | 'causality' | 'reference' | 'foreshadow';
// book node, where works happen
export interface BookNodeRecord {
  id: string;
  parent_id?: string | null; // Stage or any NodeType. Stage has null parent_id
  title: string;
  project_id: string;
  type: NodeType;
  order_key: number;
  status: NodeStatus;
  summary?: string | null; // doesn't apply to lower levels
  pos_x?: number | null;
  pos_y?: number | null;
  created_at: string;
  updated_at: string;
}

// tag for each story node
export interface NodeTagRecord {
  id: string;
  name: string;
  node_id: string;
}

// relations between nodes on the same level
export interface NodeEdgeRecord {
  id: string;
  project_id: string;
  src_node_id: string; // same level
  dst_node_id: string;
  kind: NodeEdgeKind;
  label?: string | null;
  weight: number;
  created_at: string;
  updated_at: string;
}


// book elements adhere to story nodes through links
export interface ElementNodeLinkRecord {
  id: string;
  node_id: string;
  element_id: string;
}
