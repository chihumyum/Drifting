/**
 * Finished-manuscript export: the book reduced to what a reader sees.
 *
 * Only manuscript structure travels: acts, chapters, and in each chapter's
 * prose its scene headings, paragraphs, quotes and scene breaks. Beat and
 * note headings are outline markers and stay out unless asked for; drifts,
 * elements, comments, TODOs, summaries and planning grids never enter. The
 * native side (src-tauri/src/manuscript_export) lays the result out as EPUB,
 * Word or PDF.
 */
import type { WritingStatus } from '../../domain/book-node';

export type ManuscriptFormat = 'epub' | 'pdf' | 'docx';
export const MANUSCRIPT_FORMATS: readonly ManuscriptFormat[] = ['epub', 'pdf', 'docx'];

export type ManuscriptAlign = 'justify' | 'left' | 'center' | 'right';

export interface ManuscriptRun {
  /** May contain `\n` for a hard line break. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  href?: string;
}

export type ManuscriptBlock =
  | { type: 'heading'; level: 1 | 2 | 3; runs: ManuscriptRun[]; align?: ManuscriptAlign }
  | { type: 'paragraph'; runs: ManuscriptRun[]; align?: ManuscriptAlign; indent?: number }
  | { type: 'quote'; blocks: ManuscriptBlock[] }
  | { type: 'break' };

export type ManuscriptSection =
  | { kind: 'act'; title: string }
  | { kind: 'chapter'; title: string; showTitle: boolean; blocks: ManuscriptBlock[] };

export interface ManuscriptCover {
  mediaType: 'image/jpeg' | 'image/png';
  /** Base64 image bytes. */
  data: string;
  width: number;
  height: number;
}

/** The payload `manuscript_export_save` lays out. */
export interface Manuscript {
  title: string;
  author: string;
  identifier: string;
  /** UTC `YYYY-MM-DDThh:mm:ssZ`. */
  modified: string;
  locale: string;
  preferredFont?: string;
  cover?: ManuscriptCover;
  sections: ManuscriptSection[];
}

export interface ManuscriptExportOptions {
  /** Null exports the whole book: every chapter that is not discarded. */
  chapterIds: readonly string[] | null;
  actTitles: boolean;
  chapterTitles: boolean;
  /** Beat (h2) and note (h3) headings. */
  outlineHeadings: boolean;
  title: string;
  author: string;
  cover: ManuscriptCover | null;
}

export interface ManuscriptLabels {
  untitledChapter: string;
  untitledAct: string;
}

/** A chapter as the picker lists it, in book order. */
export interface ManuscriptChapterEntry {
  id: string;
  title: string;
  writingStatus: WritingStatus;
  actId: string | null;
}

export interface ManuscriptActEntry {
  id: string;
  name: string;
}

export interface ManuscriptOutline {
  projectTitle: string;
  acts: ManuscriptActEntry[];
  chapters: ManuscriptChapterEntry[];
}

/** Chapters a whole-book export includes: everything but discarded drafts. */
export function defaultManuscriptChapterIds(chapters: readonly ManuscriptChapterEntry[]): string[] {
  return chapters.filter(chapter => chapter.writingStatus !== 'discarded').map(chapter => chapter.id);
}

interface PmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
}

const LINK = /^(https?:|mailto:)/i;

function alignOf(node: PmNode): ManuscriptAlign | undefined {
  const value = node.attrs?.textAlign;
  // The editor stores its default ("left") explicitly; only a chosen centre
  // or right alignment changes the manuscript's justified body.
  return value === 'center' || value === 'right' ? value : undefined;
}

function sameMarks(a: ManuscriptRun, b: ManuscriptRun): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline
    && !!a.strike === !!b.strike && a.href === b.href;
}

function inlineRuns(nodes: readonly PmNode[] | undefined): ManuscriptRun[] {
  const runs: ManuscriptRun[] = [];
  const push = (run: ManuscriptRun) => {
    if (!run.text) return;
    const last = runs[runs.length - 1];
    if (last && sameMarks(last, run)) last.text += run.text;
    else runs.push(run);
  };
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      const last = runs[runs.length - 1];
      if (last) last.text += '\n';
      else runs.push({ text: '\n' });
      continue;
    }
    if (typeof node.text === 'string') {
      const run: ManuscriptRun = { text: node.text };
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') run.bold = true;
        else if (mark.type === 'italic') run.italic = true;
        else if (mark.type === 'underline') run.underline = true;
        else if (mark.type === 'strike') run.strike = true;
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && LINK.test(mark.attrs.href.trim())) {
          run.href = mark.attrs.href.trim();
        }
        // Entity links, comments and highlights keep only their text.
      }
      push(run);
    } else if (node.content) {
      for (const run of inlineRuns(node.content)) push(run);
    }
  }
  return runs;
}

function blocksOf(nodes: readonly PmNode[] | undefined, outlineHeadings: boolean): ManuscriptBlock[] {
  const blocks: ManuscriptBlock[] = [];
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'heading': {
        const raw = Number(node.attrs?.level ?? 1);
        const level = (raw >= 3 ? 3 : raw <= 1 ? 1 : 2) as 1 | 2 | 3;
        // Scenes (h1) belong to the manuscript; beats and notes are outline.
        if (level > 1 && !outlineHeadings) break;
        const runs = inlineRuns(node.content);
        if (!runs.some(run => run.text.trim())) break;
        const align = alignOf(node);
        blocks.push({ type: 'heading', level, runs, ...(align ? { align } : {}) });
        break;
      }
      case 'paragraph': {
        const align = alignOf(node);
        const indent = Math.max(0, Math.min(8, Math.trunc(Number(node.attrs?.indent ?? 0)) || 0));
        blocks.push({ type: 'paragraph', runs: inlineRuns(node.content),
          ...(align ? { align } : {}), ...(indent ? { indent } : {}) });
        break;
      }
      case 'blockquote': {
        const inner = trimBlank(blocksOf(node.content, outlineHeadings));
        if (inner.length) blocks.push({ type: 'quote', blocks: inner });
        break;
      }
      case 'horizontalRule':
        blocks.push({ type: 'break' });
        break;
      default:
        // Nodes outside the prose profile still keep their words.
        if (node.content?.some(child => typeof child.text === 'string' || child.type === 'hardBreak')) {
          blocks.push({ type: 'paragraph', runs: inlineRuns(node.content) });
        } else if (node.content) {
          blocks.push(...blocksOf(node.content, outlineHeadings));
        }
    }
  }
  return blocks;
}

function isBlank(block: ManuscriptBlock): boolean {
  return block.type === 'paragraph' && !block.runs.some(run => run.text.trim());
}

function trimBlank(blocks: ManuscriptBlock[]): ManuscriptBlock[] {
  let start = 0;
  let end = blocks.length;
  while (start < end && isBlank(blocks[start]!)) start++;
  while (end > start && isBlank(blocks[end - 1]!)) end--;
  return blocks.slice(start, end);
}

/** Chapter prose (ProseMirror JSON) as manuscript blocks. Corrupt JSON throws. */
export function proseToManuscriptBlocks(contentJson: string, outlineHeadings: boolean): ManuscriptBlock[] {
  const json: unknown = JSON.parse(contentJson);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid prose document');
  const doc = json as PmNode;
  if (Object.keys(doc).length === 0) return []; // unseeded empty body
  if (doc.type !== 'doc' || (doc.content !== undefined && !Array.isArray(doc.content))) {
    throw new Error('Invalid prose document');
  }
  return trimBlank(blocksOf(doc.content, outlineHeadings));
}

export interface ManuscriptChapterProse extends ManuscriptChapterEntry {
  blocks: ManuscriptBlock[];
}

/** Order chapters and acts into sections; acts without a chosen chapter drop out. */
export function manuscriptSections(
  outline: { acts: readonly ManuscriptActEntry[] },
  chapters: readonly ManuscriptChapterProse[],
  options: Pick<ManuscriptExportOptions, 'actTitles' | 'chapterTitles'>,
  labels: ManuscriptLabels,
): ManuscriptSection[] {
  const sections: ManuscriptSection[] = [];
  const acts = new Map(outline.acts.map(act => [act.id, act]));
  let currentAct: string | null = null;
  for (const chapter of chapters) {
    if (options.actTitles && chapter.actId && chapter.actId !== currentAct) {
      const name = acts.get(chapter.actId)?.name.replace(/[\r\n\t]+/g, ' ').trim();
      sections.push({ kind: 'act', title: name || labels.untitledAct });
    }
    currentAct = chapter.actId;
    sections.push({
      kind: 'chapter',
      // Keep ideographic spaces; only line breaks become one space.
      title: chapter.title.replace(/[\r\n\t]+/g, ' ').trim() || labels.untitledChapter,
      showTitle: options.chapterTitles,
      blocks: chapter.blocks,
    });
  }
  return sections;
}

/** `2026-10-31T08:09:10Z`, the timestamp form the native side accepts. */
export function manuscriptTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function manuscriptFilename(title: string, format: ManuscriptFormat): string {
  const safe = title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-').replace(/^[.\s]+|[.\s]+$/g, '');
  // Below native's 160-byte limit even for emoji/CJK titles.
  return `${Array.from(safe || 'Drifting').slice(0, 35).join('')}.${format}`;
}
