// Domain model for a book project
export interface Project {
  id: string;
  projectName: string | null;
  author: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
