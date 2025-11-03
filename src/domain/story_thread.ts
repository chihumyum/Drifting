// Story Thread Domain Model
export interface StoryThread {
  id: string;
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  isMain: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStoryThreadInput {
  projectId: string;
  name: string;
  color: string;
  summary?: string;
  isMain?: boolean;
}

export interface UpdateStoryThreadInput {
  id: string;
  name?: string;
  color?: string;
  summary?: string;
  isMain?: boolean;
}
