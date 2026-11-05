/**
 * The imported document's title, taken off its body so it is not written
 * twice: once as the chapter's (or idea's, or element's) name and again as
 * the first line of its text.
 */
import type { JSONContent } from '@tiptap/core';

const MAX_TITLE = 80;
/** "01 ", "2_", "03-", "4. ": a short number that only orders the files. Years ("2024-…") stay. */
const ORDER_PREFIX = /^\d{1,3}[\s._-]+(?=\S)/;

/** The file name without its extension or a short ordering prefix. */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).trim() || filename;
  return stem.replace(ORDER_PREFIX, '').trim() || stem;
}

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(plainText).join('');
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * A level-1 heading that opens the document is its title and leaves the body
 * (Markdown's `# Title`, Word's Title or Heading 1). Otherwise the title is the
 * file name, and an opening paragraph or heading that only repeats it leaves
 * the body. Headings further down always stay where they are.
 */
export function takeTitle(doc: JSONContent, filename: string): { doc: JSONContent; title: string } {
  const content = doc.content ?? [];
  const [first, ...rest] = content;
  const body = (blocks: JSONContent[]): JSONContent => ({ ...doc, content: blocks.length ? blocks : [{ type: 'paragraph' }] });
  const firstText = first ? normalize(plainText(first)) : '';
  if (first?.type === 'heading' && first.attrs?.level === 1 && firstText) {
    return { doc: body(rest), title: firstText.slice(0, MAX_TITLE) };
  }
  const title = titleFromFilename(filename);
  if (first && (first.type === 'paragraph' || first.type === 'heading') && firstText === normalize(title)) {
    return { doc: body(rest), title };
  }
  return { doc, title };
}
