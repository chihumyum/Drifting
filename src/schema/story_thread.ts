// Story Thread Schema
export interface StoryThreadRecord {
  id: string;
  project_id: string;
  name: string;
  color: string;
  summary?: string | null;
  is_main: number; // 0 or 1, SQLite boolean
  created_at: string;
  updated_at: string;
}

export interface NodeThreadRecord {
  node_id: string;
  thread_id: string;
}
