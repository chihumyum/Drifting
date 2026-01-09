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