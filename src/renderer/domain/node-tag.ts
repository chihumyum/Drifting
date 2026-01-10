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

export interface StoryStage {
  id: string;
  projectId: string;
  name: string;
  color: string;
  position: number;
  createdAt: string;
}
