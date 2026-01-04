export type NodeEdgeKind = 'chronology' | 'causality' | 'reference' | 'foreshadow';

// book node, where works happen
export interface BookNodeRecord {
  id: string;
  title: string;
  project_id: string;
  start: number;                     // Position on timeline (chapter order / story time start)
  end?: number | null;               // Timeline end position (null = use default width)
  summary?: string | null;
  story_stage_id?: string | null;    // FK to story_stage, nullable
  pos_x?: number | null;
  pos_y?: number | null;
  created_at: string;
  updated_at: string;
  // 同步字段
  sync_status?: string;              // 'synced' | 'pending' | 'syncing' | 'failed'
  last_modified?: number | null;     // 最后修改时间戳
  is_deleted?: number;               // 软删除标记 (0=未删除, 1=已删除)
}

// relations between nodes on the same level
export interface NodeEdgeRecord {
  id: string;
  project_id: string;
  src_node_id: string;
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

