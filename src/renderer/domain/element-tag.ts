// Domain model for Node Tag
export interface ElementTag {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
  createdAt: string;
}

// Domain model for Element-Tag link
export interface ElementTagLink {
  elementId: string;
  tagId: string;
  createdAt: string;
}
