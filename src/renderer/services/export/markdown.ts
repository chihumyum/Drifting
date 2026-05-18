/**
 * Markdown writer. Wraps the existing per-doc exporter and stitches
 * chapters into a single file with H1 chapter headings.
 */
import { exportDocToMarkdown } from '../markdown-export.service';
import type { BookInput, ExportContext, ExportResult, FormatWriter } from './types';

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'untitled';
}

export const writeMarkdown: FormatWriter = async (
  book: BookInput,
  ctx: ExportContext,
): Promise<ExportResult> => {
  const parts: string[] = [];
  // Front matter — minimal, just title + author so static-site importers
  // (e.g. Quartz, Hugo) read something sensible. We don't try to be
  // jekyll-compatible.
  parts.push('---');
  parts.push(`title: ${JSON.stringify(book.title)}`);
  if (book.author) parts.push(`author: ${JSON.stringify(book.author)}`);
  if (book.language) parts.push(`language: ${book.language}`);
  parts.push('---', '');

  for (const chapter of book.chapters) {
    parts.push(`# ${chapter.title}`, '');
    parts.push(exportDocToMarkdown(chapter.doc, { resolveLabel: ctx.resolveLabel }));
    parts.push('');
  }

  const text = parts.join('\n');
  return {
    blob: new Blob([text], { type: 'text/markdown' }),
    filename: `${sanitizeFilename(book.title)}.md`,
    mimeType: 'text/markdown',
  };
};
