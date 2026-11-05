import * as Y from 'yjs';

import { detectEntityLinkSpans, type AutoDetectTarget, type EntityLinkAutoDetectConfig, type EntityLinkSpan } from '../extensions/entity-link';
import { isEntityLinkMarkKey } from '../location-link';
import {
  replaceYjsProseBlocks,
  snapshotYjsProseBlocks,
  type YjsProseBlock,
  type YjsProseOperation,
} from './runtime/yjs-prose-command';

// Registered names in written prose get their entity links, the way the
// editor's auto-linker gives them while the author types (see
// entity-link-name-runs.ts): a name is read across a block's text children and
// across link boundaries, but not across other formatting, and a name already
// partly linked to its target is linked whole with that same link.

type Attributes = Record<string, unknown>;

interface Piece {
  text: Y.XmlText;
  /** UTF-16 offset of this piece inside `text`. */
  offset: number;
  insert: string;
  attributes: Attributes;
}

function formattingApartFromLinks(attributes: Attributes): string {
  return JSON.stringify(
    Object.keys(attributes)
      .filter((key) => !isEntityLinkMarkKey(key) && attributes[key] !== null && attributes[key] !== undefined)
      .sort()
      .map((key) => [key, attributes[key]]),
  );
}

/** A block's text as runs whose formatting differs only in entity links. */
function nameRuns(element: Y.XmlElement): Piece[][] {
  const runs: Piece[][] = [];
  let run: Piece[] = [];
  let formatting = '';
  const close = () => {
    if (run.length > 0) runs.push(run);
    run = [];
  };
  for (const child of element.toArray()) {
    if (!(child instanceof Y.XmlText)) {
      close();
      if (child instanceof Y.XmlElement) runs.push(...nameRuns(child));
      continue;
    }
    let offset = 0;
    for (const delta of child.toDelta() as Array<{ insert: unknown; attributes?: Attributes }>) {
      if (typeof delta.insert !== 'string') {
        close();
        offset += 1;
        continue;
      }
      const attributes = delta.attributes ?? {};
      const next = formattingApartFromLinks(attributes);
      if (run.length > 0 && next !== formatting) close();
      run.push({ text: child, offset, insert: delta.insert, attributes });
      formatting = next;
      offset += delta.insert.length;
    }
  }
  close();
  return runs;
}

/** The attribute that links `attributes` to the span's target, if any. */
function sameTargetLink(attributes: Attributes, span: EntityLinkSpan): [string, unknown] | null {
  for (const [key, value] of Object.entries(attributes)) {
    if (!isEntityLinkMarkKey(key) || !value || typeof value !== 'object') continue;
    const link = value as { targetKind?: unknown; targetId?: unknown };
    if (link.targetKind === span.attrs.targetKind && link.targetId === span.attrs.targetId) return [key, value];
  }
  return null;
}

function linkSpan(run: readonly Piece[], span: EntityLinkSpan): void {
  const covered: Array<{ piece: Piece; from: number; to: number }> = [];
  let start = 0;
  for (const piece of run) {
    const end = start + piece.insert.length;
    const from = Math.max(span.from, start);
    const to = Math.min(span.to, end);
    if (from < to) covered.push({ piece, from: from - start, to: to - start });
    start = end;
  }
  const existing = covered.map(({ piece }) => sameTargetLink(piece.attributes, span));
  if (existing.every(Boolean)) return;
  // Reusing the attribute of the part already linked makes the name one link.
  const [key, value] = existing.find(Boolean) ?? ['entityLink', span.attrs];
  for (const { piece, from, to } of covered) {
    piece.text.format(piece.offset + from, to - from, { [key]: value });
  }
}

/**
 * Links the registered names in the blocks with `blockIds` of `fragment`
 * (every block for `'all'`). With `onlyTargets`, names are still read against
 * every registered name, so a longer name wins, but only those of these
 * targets are linked.
 */
export function relinkYjsBlocks(
  fragment: Y.XmlFragment,
  blockIds: readonly string[] | 'all',
  config: EntityLinkAutoDetectConfig,
  onlyTargets?: readonly AutoDetectTarget[],
): void {
  if (!config.autoDetectEnabled || config.autoDetectTargets.size === 0) return;
  const wanted = blockIds === 'all' ? null : new Set(blockIds);
  for (const block of fragment.toArray()) {
    if (!(block instanceof Y.XmlElement) || (wanted && !wanted.has(String(block.getAttribute('id'))))) continue;
    for (const run of nameRuns(block)) {
      const text = run.map((piece) => piece.insert).join('');
      for (const span of detectEntityLinkSpans(text, config)) {
        if (onlyTargets && !onlyTargets.some((target) => target.kind === span.attrs.targetKind && target.id === span.attrs.targetId)) continue;
        linkSpan(run, span);
      }
    }
  }
}

/** `blocks` with the registered names in their text linked, as {@link relinkYjsBlocks} links them. */
export function linkNamesInProseBlocks(
  blocks: readonly YjsProseBlock[],
  config: EntityLinkAutoDetectConfig,
): readonly YjsProseBlock[] {
  if (blocks.length === 0 || !config.autoDetectEnabled || config.autoDetectTargets.size === 0) return blocks;
  const doc = new Y.Doc({ gc: false });
  try {
    replaceYjsProseBlocks(doc, blocks);
    relinkYjsBlocks(doc.getXmlFragment('default'), blocks.map((block) => block.id), config);
    return snapshotYjsProseBlocks(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * An Agent prose operation with the registered names linked in the blocks it
 * writes. Linking the planned blocks, before the command is prepared, keeps
 * the links part of the operation its deterministic Yjs update derives from.
 */
export function linkNamesInProseOperation(
  operation: YjsProseOperation,
  config: EntityLinkAutoDetectConfig,
): YjsProseOperation {
  switch (operation.kind) {
    case 'insert':
    case 'append':
    case 'replace':
      return { ...operation, blocks: linkNamesInProseBlocks(operation.blocks, config) };
    case 'edit':
      return { ...operation, block: linkNamesInProseBlocks([operation.block], config)[0]! };
    case 'edit_many': {
      const blocks = linkNamesInProseBlocks(operation.edits.map((edit) => edit.block), config);
      return { ...operation, edits: operation.edits.map((edit, index) => ({ ...edit, block: blocks[index]! })) };
    }
    case 'remove':
      return operation;
  }
}
