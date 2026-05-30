/**
 * ProseMirror/TipTap JSON ↔ text helpers for the agent.
 *
 * Prose is stored as PM JSON. The agent reads it as plain text, block by
 * block. Each top-level block carries a stable `id` (from the block-id
 * extension) which we surface as `blockId` so later phases can target a
 * specific block for editing without a lossy Markdown round-trip.
 */
import type { JSONContent } from '@tiptap/core';
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
