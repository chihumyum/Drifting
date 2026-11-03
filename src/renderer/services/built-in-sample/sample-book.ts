// A book the sample writer (./write-sample.ts) lays out as a project: its
// text, people and places, storylines, timeline, notes and review items, tied
// together by keys. The built-in sample is Pride and Prejudice; the release
// screenshot library (docs/release-screenshots.md) writes others the same way.

import type { KvEntry } from '../../domain/kv';
import {
  BOOK_CHAPTERS,
  BOOK_ILLUSTRATIONS,
  chapterTitle,
  type BookChapter,
  type BookIllustration,
} from './book';
import {
  CATEGORIES,
  CHAPTER_PLANS,
  COMMENTS,
  ELEMENT_PATCHES,
  ELEMENTS,
  FINISHED_CHAPTER,
  IDEAS,
  ILLUSTRATION_FOLDER,
  ILLUSTRATION_NOTES,
  LINK_FORMS,
  MATERIAL_NOTES,
  PLOT_GRID,
  PROJECT_FACTS,
  PROJECT_MEMORY,
  RELATION_TYPES,
  RELATIONS,
  SAMPLE_PROJECT_SUMMARY,
  STORYLINES,
  TIMELINE_PINS,
  VOLUMES,
  type SampleComment,
  type SampleRelation,
  type SampleRelationType,
} from './showcase';

export interface SampleBookElement {
  key: string;
  category: string;
  name: string;
  aliases: readonly string[];
  summary: string;
  facts: readonly KvEntry[];
  body: readonly string[];
  /** A bundled illustration crop used as the element's portrait. */
  portrait?: string;
}

export interface SamplePlotGrid {
  chapter: number;
  columns: readonly string[];
  rows: readonly { label: string; cells: readonly string[] }[];
}

export interface SampleBook {
  summary: string;
  facts: readonly KvEntry[];
  /** Project Memory in the author's words, or none. */
  memory: string | null;
  /** Numbered from 1, in reading order. */
  chapters: readonly BookChapter[];
  chapterTitle(number: number): string;
  /** One per chapter, indexed by chapter number − 1; the first storyline is the primary lane. */
  chapterPlans: readonly { summary: string; storylines: readonly string[] }[];
  /** Acts, each starting just before its first chapter. */
  volumes: readonly { name: string; firstChapter: number }[];
  storylines: readonly { key: string; name: string; color: string; summary: string; body: readonly string[] }[];
  categories: readonly { key: string; name: string; color: string; body: readonly string[] }[];
  elements: readonly SampleBookElement[];
  relationTypes: readonly SampleRelationType[];
  relations: readonly SampleRelation[];
  timelinePins: readonly { beforeChapter: number; label: string }[];
  ideas: readonly { title: string; summary: string; body: readonly string[] }[];
  comments: readonly SampleComment[];
  elementPatches: readonly { element: string; chapter: number; quotation: string; title: string; body: string }[];
  /** Chapters the author has marked finished. */
  finishedChapters: readonly number[];
  plotGrid: SamplePlotGrid | null;
  /** Material notes in the material-note Markdown the Agent uses. */
  materialNotes: readonly { title: string; markdown: string }[];
  /** The folder the illustration materials go in, when there are any. */
  illustrationFolder: string | null;
  /** The note shown with each illustration material, by illustration name. */
  illustrationNotes: Readonly<Record<string, string>>;
  illustrations: readonly BookIllustration[];
  /** How the chapters name each element; a `null` element keeps a form unlinked. */
  linkForms: readonly { form: string; element: string | null }[];
  /** Latin names link between word boundaries; Han names have none to find. */
  linkBoundaries: 'word' | 'none';
}

export const PRIDE_AND_PREJUDICE: SampleBook = {
  summary: SAMPLE_PROJECT_SUMMARY,
  facts: PROJECT_FACTS,
  memory: PROJECT_MEMORY,
  chapters: BOOK_CHAPTERS,
  chapterTitle,
  chapterPlans: CHAPTER_PLANS,
  volumes: VOLUMES,
  storylines: STORYLINES,
  categories: CATEGORIES,
  elements: ELEMENTS,
  relationTypes: RELATION_TYPES,
  relations: RELATIONS,
  timelinePins: TIMELINE_PINS,
  ideas: IDEAS,
  comments: COMMENTS,
  elementPatches: ELEMENT_PATCHES,
  finishedChapters: [FINISHED_CHAPTER],
  plotGrid: PLOT_GRID,
  materialNotes: MATERIAL_NOTES,
  illustrationFolder: ILLUSTRATION_FOLDER,
  illustrationNotes: ILLUSTRATION_NOTES,
  illustrations: BOOK_ILLUSTRATIONS,
  linkForms: LINK_FORMS,
  linkBoundaries: 'word',
};
