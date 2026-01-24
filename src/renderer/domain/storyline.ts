// Storyline Domain Model
// each book contains multiple storylines in parallel

export interface Storyline {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary: string;
  descriptionJson: string; // ProseMirror document JSON
  createdAt: string;
  updatedAt: string;
}

export interface CreateStorylineInput {
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: string;
}

export interface UpdateStorylineInput {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: string;
}
