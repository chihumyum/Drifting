import { docToBlocks } from './serialize';

/** The same body-only Markdown in shared tools and the read-only disk projection.
 * One editor block occupies one line; blank lines separate blocks. */
export function proseReadMarkdown(contentJson: string): string {
  return docToBlocks(contentJson)
    .map(block => (block.markdown ?? block.text).replace(/\r?\n/gu, '<br>'))
    .join('\n\n');
}

export async function proseReadVersion(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function proseReadWindow(content: string, args: Record<string, unknown>) {
  const points = Array.from(content);
  const starts = [0];
  points.forEach((point, index) => { if (point === '\n') starts.push(index + 1); });
  const startLine = Number(args.startLine ?? 1);
  const requestedEndLine = Number(args.endLine ?? starts.length);
  if (!Number.isInteger(startLine) || startLine < 1 || startLine > starts.length ||
      !Number.isInteger(requestedEndLine) || requestedEndLine < startLine) {
    throw new Error(`Line range must be within 1–${starts.length}`);
  }
  // Readers need not know the chapter's line count before requesting a window.
  const endLine = Math.min(requestedEndLine, starts.length);
  const start = starts[startLine - 1]!;
  const end = endLine === starts.length ? points.length : starts[endLine]! - 1;
  const offset = Number(args.offset ?? start);
  if (!Number.isInteger(offset) || offset < start || offset > end) {
    throw new Error('cursor is outside the requested line range');
  }
  const limit = Math.min(32_000, Math.max(1, Number(args.limit ?? 16_000)));
  const nextOffset = Math.min(end, offset + limit);
  const page = points.slice(offset, nextOffset).join('');
  const lineStart = points.slice(0, offset).filter(point => point === '\n').length + 1;
  return {
    page, offset, nextOffset, totalChars: points.length,
    truncated: nextOffset < end,
    lineStart, lineEnd: lineStart + (page.match(/\n/gu)?.length ?? 0),
    totalLines: starts.length,
    startsMidLine: offset > 0 && points[offset - 1] !== '\n',
  };
}

export function numberProseLines(content: string, start: number): string {
  return content.split('\n').map((line, index) => `${start + index}\t${line}`).join('\n');
}
