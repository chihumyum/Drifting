import type { Project } from './project';

export interface ProjectStats {
  nodes: number;
  words: number;
  wordsReady: boolean;
  storylines: number;
  storylineLinks: number;
  elements: number;
  categories: number;
  entityRelations: number;
  inlineMentions: number;
}

export type ProjectSummary = Project & {
  stats: ProjectStats;
  source: 'local';
};
