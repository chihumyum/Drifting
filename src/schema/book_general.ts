export type EdgeKind = 'chronology' | 'causality' | 'reference' | 'foreshadow';


export interface Collection {
  id: string;
  owner: string;
  created_at: string;
  updated_at: string;
}

// aka a book. 
export interface Project {
  id: string;
  collection_id?: string;
  project_name?: string;
  author?: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

// Story stage - higher level than nodes (chapters)
// Used to group nodes into macro story phases
export interface StoryStageRecord {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  order_key: number;
  color: string | null;
  created_at: string;
  updated_at: string;
}

// Node tag - user-defined tags for categorizing nodes
export interface NodeTagRecord {
  id: string;
  project_id: string;
  name: string;
  color: string | null;
  created_at: string;
}

// Link table for node-tag many-to-many relationship
export interface NodeTagLinkRecord {
  node_id: string;
  tag_id: string;
  created_at: string;
}

