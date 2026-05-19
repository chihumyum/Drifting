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

/** UI-friendly label per target. */
export const TARGET_LABEL: Record<ImportTarget, string> = {
  chapter: '章节',
  element: '元素',
  inspiration: '浮缀',
};

export const TARGET_DESC: Record<ImportTarget, string> = {
  chapter: '主线节点 — 进时间线、参与字数统计。',
  element: '人物 / 地点 / 物件等参考资料。需选择类别。',
  inspiration: '浮缀卡 — 不归属任何故事线，独立悬浮。',
};
