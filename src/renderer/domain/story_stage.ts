// Domain model for Story Stage
export interface StoryStage {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  orderKey: number;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

// Domain model for Node Tag
export interface NodeTag {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  createdAt: string;
}

// Domain model for Node-Tag link
export interface NodeTagLink {
  nodeId: string;
  tagId: string;
  createdAt: string;
}
