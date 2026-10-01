import { docToBlocks } from '../../lib/agent/serialize';
import type { ProseEntityType } from '../../lib/yjs-doc-id';

export type MarkdownShareTarget = { projectId: string; title: string } & (
  | { kind: 'book' }
  | { kind: ProseEntityType; id: string }
);

export interface MarkdownShareDocument {
  title: string;
  filename: string;
  markdown: string;
  documentCount: number;
}

export function markdownShareHeading(title: string, level: number): string {
  // Reuse the editor's escaping rules; titles must remain a single heading.
  const text = docToBlocks(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph',
    content: [{ type: 'text', text: title.replace(/[\r\n]+/g, ' ').trim() || 'Untitled' }],
  }] }))[0]?.markdown ?? '';
  return `${'#'.repeat(level)} ${text}`;
}

export function proseToShareMarkdown(contentJson: string, headingOffset: number): string {
  // A corrupt body must fail the complete export, never quietly omit a chapter.
  const json: unknown = JSON.parse(contentJson);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid prose document');
  const doc = json as { type?: string; content?: unknown };
  if (Object.keys(doc).length === 0) return ''; // unseeded empty body
  if (doc.type !== 'doc' || (doc.content !== undefined && !Array.isArray(doc.content))) {
    throw new Error('Invalid prose document');
  }
  return docToBlocks(contentJson, true).map(block => {
    const markdown = block.markdown ?? '';
    return block.type === 'heading'
      ? markdown.replace(/^(#{1,3}) /, (_, hashes: string) => `${'#'.repeat(Math.min(6, hashes.length + headingOffset))} `)
      : markdown;
  }).join('\n\n');
}

export function markdownShareFilename(title: string): string {
  const safe = title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '-').replace(/^[.\s]+|[.\s]+$/g, '');
  // Below native's UTF-8 byte limit even for emoji/CJK titles.
  return `${Array.from(safe || 'Drifting').slice(0, 35).join('')}.md`;
}
