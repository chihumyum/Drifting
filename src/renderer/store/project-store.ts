import { create } from 'zustand';
import type { Project } from '../domain/project';

interface ProjectState {
  // Current active project
  currentProject: Project | null;
  
  // All available projects
  projects: Project[];
  
  // Actions
  setCurrentProject: (project: Project | null) => void;
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  updateProjectInList: (id: string, updates: Partial<Project>) => void;
  removeProject: (id: string) => void;
  
  // Helpers
  getCurrentProjectId: () => string | null;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  projects: [],

  setCurrentProject: (project) => set({ currentProject: project }),

  setProjects: (projects) => set({ projects }),

  addProject: (project) =>
    set((state) => ({
      projects: [...state.projects, project],
    })),

  updateProjectInList: (id, updates) =>
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, ...updates } : p
      ),
      currentProject:
        state.currentProject?.id === id
          ? { ...state.currentProject, ...updates }
          : state.currentProject,
    })),

  removeProject: (id) =>
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
    })),

  getCurrentProjectId: () => {
    const { currentProject } = get();
    return currentProject?.id ?? null;
  },
}));
