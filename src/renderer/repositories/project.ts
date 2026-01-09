import type { Project } from '../domain/project';

export interface ProjectCreateData {
  id?: string;
  projectName?: string | null;
  author?: string | null;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectUpdateData {
  projectName?: string | null;
  author?: string | null;
  description?: string | null;
  updatedAt?: string;
}

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  findAll(): Promise<Project[]>;
  create(data: ProjectCreateData): Promise<Project>;
  update(id: string, data: ProjectUpdateData): Promise<Project | null>;
  delete(id: string): Promise<boolean>;
  
  // Element category management for projects
  addElementCategory(projectId: string, categoryId: string): Promise<void>;
  removeElementCategory(projectId: string, categoryId: string): Promise<void>;
  getElementCategories(projectId: string): Promise<string[]>;
}
