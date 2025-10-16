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

// each project has multiple stages
export interface StoryStage {
  id: string;
  name: string;
  description: string;
  project_id: string;
}

// each stage contain multiple story nodes
export interface StoryStageChapterLink {
  story_stage_id: string;
  story_node_id: string;
}
