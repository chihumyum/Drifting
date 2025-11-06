// Story Thread Domain Model
export interface StoryThread {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: object; // ProseMirror document JSON
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStoryThreadInput {
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  pmJson?: object;
}

export interface UpdateStoryThreadInput {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  pmJson?: object;
}
