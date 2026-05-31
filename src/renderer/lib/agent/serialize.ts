/**
 * ProseMirror/TipTap JSON ↔ text helpers for the agent.
 *
 * Prose is stored as PM JSON. The agent reads it as plain text, block by
 * block. Each top-level block carries a stable `id` (from the block-id
 * extension) which we surface as `blockId` so later phases can target a
 * specific block for editing without a lossy Markdown round-trip.
 */
import type { JSONContent } from '@tiptap/core';
import { v7 as uuidv7 } from 'uuid';
import { parseTiptapDocJson } from '../../utils/tiptap-doc';

export interface DocBlock {
  blockId: string | null;
  type: string;
  text: string;
}

/** Concatenate all descendant text nodes of a PM node. */
function collectText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  const children = node.content;
  if (!children || children.length === 0) return '';
  return children.map(collectText).join('');
}

/** Flatten a doc's top-level blocks into { blockId, type, text }. */
export function docToBlocks(contentJson: string): DocBlock[] {
  const doc = parseTiptapDocJson(contentJson);
  const blocks: DocBlock[] = [];
  for (const node of doc.content ?? []) {
    const id = node.attrs && typeof node.attrs.id === 'string' ? node.attrs.id : null;
    blocks.push({ blockId: id, type: node.type ?? 'unknown', text: collectText(node) });
  }
  return blocks;
}

/** Whole-doc plain text (blocks joined by blank lines). */
export function docToPlainText(contentJson: string): string {
  return docToBlocks(contentJson)
    .map((b) => b.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
}

/**
 * Replace the text of one top-level block (matched by its block id), keeping
 * the block's type and id. Block-level replacement only — inline marks within
 * the block are dropped. Throws if the block isn't found.
 */
export function replaceBlockText(contentJson: string, blockId: string, newText: string): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks = doc.content ?? [];
  let found = false;
  const next: JSONContent[] = blocks.map((node) => {
    if (node.attrs && node.attrs.id === blockId) {
      found = true;
      return { ...node, content: newText ? [{ type: 'text', text: newText }] : [] };
    }
    return node;
  });
  if (!found) throw new Error(`Block "${blockId}" not found in this node`);
  return JSON.stringify({ ...doc, content: next });
}

/**
 * Replace the text of the Nth top-level block (1-based, matching docToBlocks
 * order — the numbering the agent sees from read_chapter). Lossy on inline
 * marks, same as replaceBlockText. Throws if the index is out of range.
 */
export function replaceBlockByIndex(contentJson: string, index: number, newText: string): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks = doc.content ?? [];
  const i = index - 1;
  if (!Number.isInteger(i) || i < 0 || i >= blocks.length) {
    throw new Error(`Block #${index} out of range (1..${blocks.length})`);
  }
  const next: JSONContent[] = blocks.map((node, idx) =>
    idx === i ? { ...node, content: newText ? [{ type: 'text', text: newText }] : [] } : node,
  );
  return JSON.stringify({ ...doc, content: next });
}

// Non-paragraph block types get a short prefix so the agent can tell them apart
// without a verbose `type` field. Paragraphs (the overwhelming majority) get none.
const TYPE_PREFIX: Record<string, string> = {
  heading: '# ',
  blockquote: '> ',
  codeBlock: '` ',
  listItem: '- ',
  bulletList: '- ',
  orderedList: '1. ',
};

/**
 * Render blocks as a compact numbered list — one block per line, `<n>\t<text>`,
 * with a type prefix only for non-paragraph blocks. The number is the handle
 * the agent passes to edit_block. Far cheaper than per-block {blockId,type,text}
 * JSON (no uuid, no repeated keys, no pretty-print).
 */
export function blocksToCompactText(blocks: DocBlock[]): string {
  return blocks
    .map((b, i) => {
      const prefix = b.type === 'paragraph' ? '' : TYPE_PREFIX[b.type] ?? `[${b.type}] `;
      const text = b.text.replace(/\s*\n\s*/g, ' ');
      return `${i + 1}\t${prefix}${text}`;
    })
    .join('\n');
}

/** Append a new paragraph (with a fresh block id) to the end of the doc. */
export function appendParagraph(contentJson: string, text: string): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks: JSONContent[] = doc.content ? [...doc.content] : [];
  blocks.push({
    type: 'paragraph',
    attrs: { id: uuidv7() },
    content: text ? [{ type: 'text', text }] : [],
  });
  return JSON.stringify({ ...doc, content: blocks });
}
