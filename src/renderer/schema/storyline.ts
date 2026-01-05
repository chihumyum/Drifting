// Storyline Schema
export interface StorylineRecord {
  id: string;
  project_id: string;
  name: string;
  color: string;
  summary?: string | null;
  pm_json?: string | null; // ProseMirror document JSON
  created_at: string;
  updated_at: string;
  // 同步字段
  sync_status?: string;
  last_modified?: number | null;
  is_deleted?: number;
}

export interface NodeStorylineRecord {
  node_id: string;
  storyline_id: string;
  storyline_order: number; // Determines which storyline is primary for a node (0 = primary)
}
}
