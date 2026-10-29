import type { Project } from './project';

export interface ProjectStats {
  nodes: number;
  chapters: number;
  words: number;
  wordsReady: boolean;
  storylines: number;
  storylineLinks: number;
  elements: number;
  categories: number;
  entityRelations: number;
  inlineMentions: number;
}

/** What the shelf cover draws: each storyline, in the author's order, with its
 * colour and the chapters it runs through (indexes in reading order). */
export interface ProjectCover {
  storylines: Array<{ color: string; chapters: number[] }>;
}

export type ProjectSummary = Project & {
  stats: ProjectStats;
  cover: ProjectCover;
  source: 'local';
};
