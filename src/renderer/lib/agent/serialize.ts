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
