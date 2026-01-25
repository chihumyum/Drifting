// Domain model for Node Tag
export interface ElementTag {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// Domain model for Element-Tag link
export interface ElementTagLink {
  elementId: string;
  tagId: string;
}
