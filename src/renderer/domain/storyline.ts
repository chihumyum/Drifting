// Storyline Domain Model
export interface Storyline {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: object; // ProseMirror document JSON
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStorylineInput {
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: object;
}

export interface UpdateStorylineInput {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: object;
}
