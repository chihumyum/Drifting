/**
 * Share link document v1: the reader copy of one entity's prose that the
 * client publishes to the Hosted service (docs/share-links.md). The desktop
 * client builds it from live Yjs prose; the web reader (src/share-web) renders
 * it and anchors readers' comments to it.
 *
 * A block's plain text is the concatenation of its runs' text and equals the
 * ProseMirror block's `textContent`, so comment offsets mean the same thing in
 * the reader and in the editor. Hard breaks are runs without text.
 *
 * Key order matches the service's normalized form, so an unchanged copy hashes
 * the same on both sides and republishing it keeps its revision.
 */
export const SHARE_DOCUMENT_VERSION = 1;
export const SHARE_TITLE_MAX = 200;

export type ShareMark = 'bold' | 'italic' | 'strike' | 'underline';
const SHARE_MARKS: readonly ShareMark[] = ['bold', 'italic', 'strike', 'underline'];

export interface ShareRun {
  text: string;
  marks?: ShareMark[];
  href?: string;
  br?: true;
}

export interface ShareBlock {
  /** The editor block id comments anchor to; null for a block without one. */
  id: string | null;
  type: 'paragraph' | 'heading' | 'rule';
  level?: 1 | 2 | 3;
  quote?: true;
  align?: 'center' | 'right';
  indent?: number;
  runs: ShareRun[];
}

export type ShareDocumentKind = 'chapter' | 'drift' | 'element' | 'storyline' | 'category';

export interface ShareDocument {
  v: 1;
  title: string;
  kind: ShareDocumentKind;
  blocks: ShareBlock[];
}

/** The comment anchor readers send; the shape of the client's CommentAnchorPayload. */
export interface ShareCommentAnchor {
  targetBlockId: string | null;
  targetBlockIds: string[];
  selectedText: string;
  blockText: string;
  blockSelectionFrom: number;
  blockSelectionTo: number;
  blockSnapshots: { blockId: string | null; blockText: string }[];
  textAnchor: {
    startBlockId: string;
    startOffset: number;
    endBlockId: string;
    endOffset: number;
    text: string;
  } | null;
}

export function shareBlockText(block: ShareBlock): string {
  let text = '';
  for (const run of block.runs) text += run.text;
  return text;
}

interface ProseNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: ProseNode[];
}

function normalizedHref(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function inlineRuns(node: ProseNode, runs: ShareRun[]): void {
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') {
      runs.push({ text: '', br: true });
      continue;
    }
    if (child.type !== 'text') {
      // An unknown inline node keeps its text, if any, so offsets stay aligned.
      if (child.content) inlineRuns(child, runs);
      continue;
    }
    if (!child.text) continue;
    const marks = SHARE_MARKS.filter(mark => child.marks?.some(item => item.type === mark));
    const link = child.marks?.find(item => item.type === 'link');
    const href = link ? normalizedHref(link.attrs?.href) : undefined;
    const previous = runs[runs.length - 1];
    if (previous && !previous.br && previous.href === href
      && (previous.marks ?? []).join() === marks.join()) {
      previous.text += child.text;
      continue;
    }
    const run: ShareRun = { text: child.text };
    if (marks.length) run.marks = marks;
    if (href) run.href = href;
    runs.push(run);
  }
}

function textBlock(node: ProseNode, quote: boolean): ShareBlock {
  const id = typeof node.attrs?.id === 'string' && node.attrs.id ? node.attrs.id : null;
  const runs: ShareRun[] = [];
  inlineRuns(node, runs);
  const block: ShareBlock = { id, type: node.type === 'heading' ? 'heading' : 'paragraph', runs };
  if (block.type === 'heading') {
    const level = node.attrs?.level;
    block.level = level === 1 || level === 2 ? level : 3;
  }
  if (quote) block.quote = true;
  const align = node.attrs?.textAlign;
  if (align === 'center' || align === 'right') block.align = align;
  const indent = node.attrs?.indent;
  if (typeof indent === 'number' && Number.isInteger(indent) && indent > 0) block.indent = Math.min(indent, 8);
  return block;
}

function collectBlocks(nodes: readonly ProseNode[], quote: boolean, blocks: ShareBlock[]): void {
  for (const node of nodes) {
    if (node.type === 'paragraph' || node.type === 'heading') {
      blocks.push(textBlock(node, quote));
    } else if (node.type === 'horizontalRule') {
      blocks.push({ id: typeof node.attrs?.id === 'string' ? node.attrs.id : null, type: 'rule', runs: [] });
    } else if (node.type === 'blockquote') {
      collectBlocks(node.content ?? [], true, blocks);
    } else if (node.content?.some(child => child.type === 'text' || child.type === 'hardBreak')) {
      blocks.push(textBlock(node, quote));
    } else if (node.content) {
      collectBlocks(node.content, quote, blocks);
    }
  }
}

/** The reader copy of a prose body (ProseMirror JSON) under a title. */
export function proseJsonToShareDocument(
  prose: unknown,
  title: string,
  kind: ShareDocumentKind,
): ShareDocument {
  const blocks: ShareBlock[] = [];
  const root = prose && typeof prose === 'object' ? (prose as ProseNode) : {};
  collectBlocks(Array.isArray(root.content) ? root.content : [], false, blocks);
  return { v: 1, title: title.slice(0, SHARE_TITLE_MAX).trim(), kind, blocks };
}
