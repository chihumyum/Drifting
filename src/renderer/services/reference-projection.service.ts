import type { Node as PMNode } from '@tiptap/pm/model';
import { isBlockType } from '../lib/extensions/block-id';
import type { InlineReferenceDraft } from '../sqlite-repo/reference-repo';
import {
  isStructuralEntityKind,
  type InlineMentionKind,
} from '../domain/entity-kinds';

interface Span {
  from: number;
  to: number;
  text: string;
}

interface BlockInfo {
  blockId: string;
  blockStart: number;
}

interface ReferenceMetadata {
  fromBlockId: string;
  toKind: InlineMentionKind;
  toId: string;
  toBlockId: string | null;
}

interface JsonNode {
  type?: unknown;
  attrs?: unknown;
  text?: unknown;
  marks?: unknown;
  content?: unknown;
}

interface JsonBlockContext {
  blockId: string;
  offset: number;
}

// Walk up the ancestor chain at `pos` and find the closest block-typed node
// that carries an id attribute. Returns null if no such ancestor exists, which
// means the text isn't anchored to a stable block yet (the BlockId extension
// will catch up on the next tick).
function findContainingBlock(doc: PMNode, pos: number): BlockInfo | null {
  const resolved = doc.resolve(pos);
  for (let depth = resolved.depth; depth >= 0; depth--) {
    const node = resolved.node(depth);
    if (!isBlockType(node.type.name)) continue;
    const id = node.attrs?.id as string | null | undefined;
    if (!id) continue;
    return { blockId: id, blockStart: resolved.start(depth) };
  }
  return null;
}

// Walk a ProseMirror document and produce one InlineReferenceDraft per
// (block, target) pair. All spans of the same target inside the same block are
// aggregated into one row; offsets are relative to the containing block's
// content start so they survive block-internal edits as the block id stays
// stable.
export function projectInlineReferencesFromDoc(doc: PMNode): InlineReferenceDraft[] {
  // key = blockId::targetKind::targetId::targetBlockId
  const spanBuckets = new Map<string, Span[]>();
  const metadata = new Map<string, ReferenceMetadata>();

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    const links = node.marks.filter((m) => m.type.name === 'entityLink');
    if (links.length === 0) return;

    const block = findContainingBlock(doc, pos);
    if (!block) return;

    const from = pos - block.blockStart;
    const to = from + node.text.length;
    const text = node.text;

    for (const mark of links) {
      addSpanToBuckets(spanBuckets, metadata, block.blockId, from, to, text, mark.attrs);
    }
  });

  return draftsFromBuckets(spanBuckets, metadata);
}

export function projectInlineReferencesFromJson(json: unknown): InlineReferenceDraft[] {
  const spanBuckets = new Map<string, Span[]>();
  const metadata = new Map<string, ReferenceMetadata>();

  const walk = (nodeValue: unknown, activeBlock: JsonBlockContext | null): void => {
    const node = asRecord(nodeValue) as JsonNode | null;
    if (!node) return;

    const typeName = typeof node.type === 'string' ? node.type : '';
    const attrs = asRecord(node.attrs);
    const blockId = typeof attrs?.id === 'string' && attrs.id ? attrs.id : null;
    const currentBlock =
      typeName && isBlockType(typeName) && blockId
        ? { blockId, offset: 0 }
        : activeBlock;

    const text = typeof node.text === 'string' ? node.text : '';
    if (text && currentBlock) {
      const from = currentBlock.offset;
      const to = from + text.length;
      const marks = Array.isArray(node.marks) ? node.marks : [];

      for (const markValue of marks) {
        const mark = asRecord(markValue);
        if (mark?.type !== 'entityLink') continue;
        addSpanToBuckets(
          spanBuckets,
          metadata,
          currentBlock.blockId,
          from,
          to,
          text,
          asRecord(mark.attrs) ?? {},
        );
      }

      currentBlock.offset = to;
    }

    const content = Array.isArray(node.content) ? node.content : [];
    for (const child of content) {
      walk(child, currentBlock);
    }

    if (!text && currentBlock && content.length === 0 && isInlineLeaf(typeName)) {
      currentBlock.offset += 1;
    }
  };

  walk(json, null);
  return draftsFromBuckets(spanBuckets, metadata);
}

function addSpanToBuckets(
  spanBuckets: Map<string, Span[]>,
  metadata: Map<string, ReferenceMetadata>,
  fromBlockId: string,
  from: number,
  to: number,
  text: string,
  attrs: Record<string, unknown>,
): void {
  const targetKind = normalizeEntityKind(attrs.targetKind);
  const targetId = typeof attrs.targetId === 'string' && attrs.targetId ? attrs.targetId : null;
  if (!targetKind || !targetId) return;
  const targetBlockId =
    typeof attrs.targetBlockId === 'string' && attrs.targetBlockId ? attrs.targetBlockId : null;

  const key = `${fromBlockId}::${targetKind}::${targetId}::${targetBlockId ?? ''}`;

  const existing = spanBuckets.get(key);
  if (existing) {
    existing.push({ from, to, text });
  } else {
    spanBuckets.set(key, [{ from, to, text }]);
    metadata.set(key, {
      fromBlockId,
      toKind: targetKind,
      toId: targetId,
      toBlockId: targetBlockId,
    });
  }
}

function draftsFromBuckets(
  spanBuckets: Map<string, Span[]>,
  metadata: Map<string, ReferenceMetadata>,
): InlineReferenceDraft[] {
  const drafts: InlineReferenceDraft[] = [];
  for (const [key, spans] of spanBuckets) {
    const meta = metadata.get(key)!;
    drafts.push({
      fromBlockId: meta.fromBlockId,
      fromSpansJson: JSON.stringify(spans),
      toKind: meta.toKind,
      toId: meta.toId,
      toBlockId: meta.toBlockId,
    });
  }
  return drafts;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEntityKind(value: unknown): InlineMentionKind | null {
  // Inline mentions can only point at structural entities (memo / material
  // are sources of references, not targets of mentions inside body text).
  return isStructuralEntityKind(value) ? value : null;
}

function isInlineLeaf(typeName: string): boolean {
  return typeName === 'hardBreak';
}
