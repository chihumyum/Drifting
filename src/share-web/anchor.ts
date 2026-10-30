// Reader comment anchors in the shape the desktop editor writes them
// (domain/comment.ts CommentAnchorPayload), so an imported reader comment is
// highlighted and re-located like one the author made. Offsets index a block's
// plain text, which equals the editor block's textContent.
import { shareBlockText, type ShareBlock, type ShareCommentAnchor } from '../shared/share-document';

export interface BlockPoint {
  /** Index into the document's blocks. */
  index: number;
  /** Character offset within that block's plain text. */
  offset: number;
}

export interface LocatedAnchor {
  start: BlockPoint;
  end: BlockPoint;
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

/** The anchor for a selection between two points, or null when it holds no commentable text. */
export function anchorForSelection(blocks: readonly ShareBlock[], start: BlockPoint, end: BlockPoint): ShareCommentAnchor | null {
  if (end.index < start.index || (end.index === start.index && end.offset <= start.offset)) return null;
  const spanned: { index: number; id: string; text: string }[] = [];
  for (let index = start.index; index <= end.index; index++) {
    const block = blocks[index];
    if (block && block.type !== 'rule' && block.id) spanned.push({ index, id: block.id, text: shareBlockText(block) });
  }
  if (!spanned.length) return null;
  const first = spanned[0]!;
  const last = spanned[spanned.length - 1]!;
  let startOffset = first.index === start.index ? Math.min(start.offset, first.text.length) : 0;
  let endOffset = last.index === end.index ? Math.min(end.offset, last.text.length) : last.text.length;
  // Like the editor, the selection is trimmed; the offsets follow within the end blocks.
  while (startOffset < (first === last ? endOffset : first.text.length) && /\s/.test(first.text[startOffset]!)) startOffset++;
  while (endOffset > (first === last ? startOffset : 0) && /\s/.test(last.text[endOffset - 1]!)) endOffset--;
  const parts = spanned.map(block => block.text.slice(block === first ? startOffset : 0, block === last ? endOffset : block.text.length));
  const selectedText = parts.join('\n').trim();
  if (!selectedText) return null;
  const single = first === last;
  return {
    targetBlockId: first.id,
    targetBlockIds: spanned.map(block => block.id),
    selectedText,
    blockText: first.text,
    blockSelectionFrom: single ? startOffset : -1,
    blockSelectionTo: single ? endOffset : -1,
    blockSnapshots: spanned.map(block => ({ blockId: block.id, blockText: block.text })),
    textAnchor: { startBlockId: first.id, startOffset, endBlockId: last.id, endOffset, text: selectedText },
  };
}

function nearest(haystack: string, needle: string, expected: number): number | null {
  if (!needle) return null;
  let best: number | null = null;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    if (best === null || Math.abs(index - expected) < Math.abs(best - expected)) best = index;
  }
  return best;
}

function textBetween(texts: readonly string[], start: BlockPoint, end: BlockPoint): string {
  const parts: string[] = [];
  for (let index = start.index; index <= end.index; index++) {
    const text = texts[index] ?? '';
    parts.push(text.slice(index === start.index ? start.offset : 0, index === end.index ? end.offset : text.length));
  }
  return parts.join('\n');
}

/**
 * Where an anchor's text is in the current copy: its own offsets while the
 * text still matches, else the nearest occurrence of the captured fragments.
 * Null when the passage has since been rewritten or removed.
 */
export function locateAnchor(blocks: readonly ShareBlock[], anchor: ShareCommentAnchor): LocatedAnchor | null {
  const range = anchor.textAnchor;
  if (!range) return null;
  const startIndex = blocks.findIndex(block => block.id === range.startBlockId);
  const endIndex = blocks.findIndex(block => block.id === range.endBlockId);
  if (startIndex < 0 || endIndex < startIndex) return null;
  const texts = blocks.map(shareBlockText);
  const expected = normalize(range.text);
  const matches = (start: BlockPoint, end: BlockPoint) =>
    (end.index > start.index || end.offset > start.offset) && normalize(textBetween(texts, start, end)) === expected;
  const direct = { start: { index: startIndex, offset: range.startOffset }, end: { index: endIndex, offset: range.endOffset } };
  if (range.endOffset <= texts[endIndex]!.length && matches(direct.start, direct.end)) return direct;
  if (startIndex === endIndex) {
    const at = nearest(texts[startIndex]!, range.text, range.startOffset);
    return at === null ? null : { start: { index: startIndex, offset: at }, end: { index: startIndex, offset: at + range.text.length } };
  }
  const startSnapshot = anchor.blockSnapshots.find(snapshot => snapshot.blockId === range.startBlockId);
  const endSnapshot = anchor.blockSnapshots.find(snapshot => snapshot.blockId === range.endBlockId);
  if (!startSnapshot || !endSnapshot) return null;
  const head = startSnapshot.blockText.slice(range.startOffset);
  const tail = endSnapshot.blockText.slice(0, range.endOffset);
  const from = nearest(texts[startIndex]!, head, range.startOffset);
  const to = nearest(texts[endIndex]!, tail, 0);
  if (from === null || to === null) return null;
  const relocated = { start: { index: startIndex, offset: from }, end: { index: endIndex, offset: to + tail.length } };
  return matches(relocated.start, relocated.end) ? relocated : null;
}

/** The link token of a reader URL (`/s/<token>`). */
export function tokenFromPath(pathname: string): string | null {
  const match = /\/s\/([A-Za-z0-9_-]{16,64})\/?$/.exec(pathname);
  return match ? match[1]! : null;
}

export function comparePoints(a: BlockPoint, b: BlockPoint): number {
  return a.index - b.index || a.offset - b.offset;
}
