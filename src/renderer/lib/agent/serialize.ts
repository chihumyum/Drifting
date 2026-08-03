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
import {
  normalizeAgentMarkdownLink,
  renderAgentProseMarkdownBlock,
  type AgentMarkdownBlock,
  type AgentMarkdownInline,
  type AgentMarkdownMarks,
} from './markdown-prose-adapter';

export interface DocBlock {
  blockId: string | null;
  type: string;
  text: string;
  /** Schema-safe Markdown used by the Agent's virtual prose filesystem. */
  markdown?: string;
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
    blocks.push({
      blockId: id,
      type: node.type ?? 'unknown',
      text: collectText(node),
      markdown: renderAgentProseMarkdownBlock(jsonBlockToAgentMarkdown(node)),
    });
  }
  return blocks;
}

function jsonBlockToAgentMarkdown(node: JSONContent): AgentMarkdownBlock {
  if (node.type === 'horizontalRule') return { type: 'horizontalRule', inline: [] };
  const inline =
    node.type === 'blockquote'
      ? flattenJsonBlockquoteInline(node.content ?? [])
      : jsonNodesToAgentInline(node.content ?? []);
  if (node.type === 'heading') {
    const rawLevel = node.attrs?.level;
    const level = rawLevel == null ? 1 : rawLevel;
    if (level === 1 || level === 2 || level === 3) {
      return { type: 'heading', level, inline };
    }
  }
  if (node.type === 'blockquote') return { type: 'blockquote', inline };
  return { type: 'paragraph', inline };
}

function flattenJsonBlockquoteInline(nodes: readonly JSONContent[]): AgentMarkdownInline[] {
  return nodes.flatMap((node, index) => [
    ...(index > 0 ? ([{ kind: 'hardBreak' }, { kind: 'hardBreak' }] as const) : []),
    ...jsonNodesToAgentInline(node.content ?? [node]),
  ]);
}

function jsonNodesToAgentInline(nodes: readonly JSONContent[]): AgentMarkdownInline[] {
  const inline: AgentMarkdownInline[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      inline.push({ kind: 'hardBreak' });
      continue;
    }
    if (node.type === 'text') {
      const marks = jsonMarksToAgentMarkdown(node.marks);
      if (node.text) {
        inline.push({
          kind: 'text',
          text: node.text,
          ...(Object.keys(marks).length > 0 ? { marks } : {}),
        });
      }
      continue;
    }
    inline.push(...jsonNodesToAgentInline(node.content ?? []));
  }
  return inline;
}

function jsonMarksToAgentMarkdown(marks: JSONContent['marks']): AgentMarkdownMarks {
  const result: AgentMarkdownMarks = {};
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') result.bold = true;
    else if (mark.type === 'italic') result.italic = true;
    else if (mark.type === 'strike') result.strike = true;
    else if (mark.type === 'underline') result.underline = true;
    else if (mark.type === 'link') {
      const link = normalizeAgentMarkdownLink(mark.attrs?.href);
      if (link) result.link = link;
    }
  }
  return result;
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
 * order — the numbering the agent sees from read_node). Lossy on inline
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

/**
 * Render blocks as a compact numbered list — one block per line, `<n>\t<text>`,
 * using only Markdown that maps to the live editor schema. The number is the
 * handle the agent passes to edit_block. Unsupported legacy node styles are
 * deliberately rendered as plain text instead of being advertised as usable.
 */
export function blocksToCompactText(blocks: DocBlock[]): string {
  return blocks
    .map((b, i) => {
      const markdown = b.markdown ?? renderDocBlockFallback(b);
      return `${i + 1}\t${markdown.replace(/\r?\n/gu, '<br>')}`;
    })
    .join('\n');
}

function renderDocBlockFallback(block: DocBlock): string {
  const inline: AgentMarkdownInline[] = block.text
    ? [{ kind: 'text', text: block.text }]
    : [];
  const adapted: AgentMarkdownBlock =
    block.type === 'heading'
      ? { type: 'heading', level: 1, inline }
      : block.type === 'blockquote'
        ? { type: 'blockquote', inline }
        : block.type === 'horizontalRule'
          ? { type: 'horizontalRule', inline: [] }
          : { type: 'paragraph', inline };
  return renderAgentProseMarkdownBlock(adapted);
}

/** Append a new paragraph (with a fresh block id) to the end of the doc. */
export function appendParagraph(contentJson: string, text: string): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks: JSONContent[] = doc.content ? [...doc.content] : [];
  blocks.push(makeParagraphBlock(text));
  return JSON.stringify({ ...doc, content: blocks });
}

// ---- structural (block count changes) — id-addressed only ------------------
//
// These add/remove top-level blocks, so ordinal numbers shift the moment one
// runs. They therefore address blocks by their stable uuid `id`, never by the
// 1-based number from read_node (which is only safe for in-place text swaps).

/** A fresh plain paragraph block with a new uuid id. */
export function makeParagraphBlock(text: string): JSONContent {
  return {
    type: 'paragraph',
    attrs: { id: uuidv7() },
    content: text ? [{ type: 'text', text }] : [],
  };
}

function indexOfBlockId(blocks: JSONContent[], blockId: string): number {
  return blocks.findIndex((n) => n.attrs && n.attrs.id === blockId);
}

/** Remove the listed blocks (by uuid). Throws if none matched. */
export function removeBlocks(contentJson: string, blockIds: string[]): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks = doc.content ?? [];
  const ids = new Set(blockIds);
  const next = blocks.filter((n) => !(n.attrs && ids.has(n.attrs.id as string)));
  if (next.length === blocks.length) {
    throw new Error(`No blocks matched ids: ${blockIds.join(', ')}`);
  }
  return JSON.stringify({ ...doc, content: next });
}

/**
 * Replace the inclusive range of blocks [fromBlockId … toBlockId] with new
 * paragraphs (one per string). Pass an empty array to just delete the range.
 */
export function replaceBlockRange(
  contentJson: string,
  fromBlockId: string,
  toBlockId: string,
  texts: string[],
): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks = doc.content ?? [];
  const fi = indexOfBlockId(blocks, fromBlockId);
  const ti = indexOfBlockId(blocks, toBlockId);
  if (fi < 0) throw new Error(`from block "${fromBlockId}" not found`);
  if (ti < 0) throw new Error(`to block "${toBlockId}" not found`);
  if (fi > ti) throw new Error('fromBlockId must be at or before toBlockId in the chapter');
  const next = [...blocks.slice(0, fi), ...texts.map(makeParagraphBlock), ...blocks.slice(ti + 1)];
  return JSON.stringify({ ...doc, content: next });
}

/**
 * Insert new paragraphs after `afterBlockId` (or at the very start when null).
 */
export function insertBlocks(
  contentJson: string,
  afterBlockId: string | null,
  texts: string[],
): string {
  const doc = parseTiptapDocJson(contentJson);
  const blocks = doc.content ?? [];
  let at = 0;
  if (afterBlockId) {
    const i = indexOfBlockId(blocks, afterBlockId);
    if (i < 0) throw new Error(`after block "${afterBlockId}" not found`);
    at = i + 1;
  }
  const next = [...blocks.slice(0, at), ...texts.map(makeParagraphBlock), ...blocks.slice(at)];
  return JSON.stringify({ ...doc, content: next });
}

/** Look up blocks by 1-based ordinal and/or a case-insensitive content match. */
export function findBlocks(
  contentJson: string,
  opts: { ordinal?: number; contains?: string },
): Array<{ blockId: string | null; block: number; type: string; snippet: string }> {
  const needle = opts.contains?.trim().toLowerCase();
  const out: Array<{ blockId: string | null; block: number; type: string; snippet: string }> = [];
  docToBlocks(contentJson).forEach((b, i) => {
    const block = i + 1;
    if (opts.ordinal != null && block !== opts.ordinal) return;
    if (needle && !b.text.toLowerCase().includes(needle)) return;
    out.push({ blockId: b.blockId, block, type: b.type, snippet: b.text.slice(0, 100) });
  });
  return out;
}
