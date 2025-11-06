// Story Thread Schema
export interface StoryThreadRecord {
  id: string;
  project_id: string;
  name: string;
  color: string;
  summary?: string | null;
  pm_json?: string | null; // ProseMirror document JSON
  created_at: string;
  updated_at: string;
}

export interface NodeThreadRecord {
  node_id: string;
  thread_id: string;
  thread_order: number; // Determines which thread is primary for a node (0 = primary)
}
