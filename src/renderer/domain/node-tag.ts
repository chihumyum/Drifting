// Domain model for Node Tag
export interface NodeTag {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

// Domain model for Node-Tag link
export interface NodeTagLink {
  nodeId: string;
  tagId: string;
}
