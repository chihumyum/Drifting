/**
 * Shared types for the import pipeline.
 *
 * One parser per source format (md/txt/docx). Each produces a normalized
 * `ParsedDoc` — a Tiptap-compatible JSON doc plus a guessed title. The
 * dispatcher in `index.ts` picks a parser by file extension; the caller
 * (ImportDialog) takes the ParsedDoc + a chosen target type and creates
 * the actual entity via the project's usecase hooks.
 *
 * Why we don't import directly into the DB from these parsers: the
 * usecases own optimistic UI updates, projection rebuilds, and the sync
 * queue. Bypassing them would mean entities show up only after a full
 * reload, and the server wouldn't get a push.
 */
import type { JSONContent } from '@tiptap/core';

export type ImportFormat = 'markdown' | 'txt' | 'docx';

export interface ParsedDoc {
  /** Tiptap/ProseMirror JSON. Always `{ type: 'doc', content: [...] }`. */
  doc: JSONContent;
  /**
   * Title guessed from the source file. For markdown that's usually the
   * first H1; for txt the first non-empty line; for docx the filename
   * without extension. The dialog displays this and lets the user edit
   * before committing — never persisted without confirmation.
   */
  guessedTitle: string;
  /** Source filename, for diagnostics + fallback title. */
  filename: string;
  /** Detected format — drives icon / debug logs. */
  format: ImportFormat;
  /** Non-fatal warnings (lost formatting, unknown mark, etc.) */
  warnings?: string[];
}

export type ImportTarget = 'chapter' | 'element' | 'inspiration';

export function inferFormat(filename: string): ImportFormat | null {
  const ext = filename.toLowerCase().split('.').pop();
  if (!ext) return null;
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'txt';
  if (ext === 'docx') return 'docx';
  return null;
}

const importPathOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

/** File picker enumeration is not ordered, especially for directory uploads. */
export function orderImportFiles<T extends { name: string; webkitRelativePath?: string }>(
  files: readonly T[],
): T[] {
  return [...files].sort((left, right) => {
    const a = left.webkitRelativePath || left.name;
    const b = right.webkitRelativePath || right.name;
    return importPathOrder.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/** UI-friendly label per target. */
export const TARGET_LABEL: Record<ImportTarget, string> = {
  chapter: 'Chapter',
  element: 'Element',
  inspiration: 'Idea',
};

export const TARGET_DESC: Record<ImportTarget, string> = {
  chapter: 'Mainline node that enters the timeline and word counts.',
  element: 'Reference material such as people, places, and objects. Requires a category.',
  inspiration: 'Free-floating idea card outside storylines.',
};
