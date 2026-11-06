// In-prose comment anchors. This module resolves a comment's anchor to live
// DOM Ranges and keeps which comment is pointed at or selected;
// lib/comment-sand.ts draws each anchor as sand on a layer under the prose.
// That was chosen over a CSS class on the block — ProseMirror strips
// externally-added `class` from the nodes it manages — and over inline
// decorations, which split text nodes under IME composition. It does not
// mutate the prose DOM, so painting (a) survives PM reconciliation and (b)
// supports fine-grained text-level anchoring (a comment pinned to a phrase
// highlights just that phrase; a whole-block anchor highlights the block).
//
// Unresolved notes and TODOs keep a resting mark; Copilot proposals stay
// quiet. The comment whose Review or sticky card is hovered is drawn
// stronger (`commentHighlightNames` names which layers a comment takes).
import {
  commentBlockIds,
  commentColorKey,
  getBlockSnapshotsFromAnchor,
  getTextAnchorFromAnchor,
  type Comment,
  type CommentColorKey,
  type CommentTextAnchor,
} from '../domain/comment';

const RESTING_HIGHLIGHT: Partial<Record<CommentColorKey, string>> = {
  todo: 'comment-hl-todo',
  manual: 'comment-hl-manual',
};
const ACTIVE_HIGHLIGHT: Record<CommentColorKey, string> = {
  todo: 'comment-hl-todo-active',
  manual: 'comment-hl-manual-active',
  copilot: 'comment-hl-copilot-active',
};
// Up to this many comments, look blocks up one by one; beyond it, index the
// scroller once (the whole-book reader can hold thousands of blocks).
const DIRECT_BLOCK_LOOKUP_LIMIT = 8;

export type BlockLookup = (id: string) => HTMLElement | null;

// The whole-book reader keeps a chapter's static copy, hidden from assistive
// technology, stacked under its live editor (and the other way round while
// the editor loads): the copy that is shown wins.
const hiddenCopy = (el: HTMLElement) => el.closest('[aria-hidden="true"]') !== null;

export function blockLookup(scrollEl: HTMLElement, wanted: { readonly length: number }): BlockLookup {
  if (wanted.length > DIRECT_BLOCK_LOOKUP_LIMIT) {
    const blocks = new Map<string, HTMLElement>();
    scrollEl.querySelectorAll<HTMLElement>('[data-block-id]').forEach((el) => {
      const id = el.getAttribute('data-block-id');
      if (!id) return;
      const known = blocks.get(id);
      if (!known || (hiddenCopy(known) && !hiddenCopy(el))) blocks.set(id, el);
    });
    return (id) => blocks.get(id) ?? null;
  }
  return (id) => {
    const copies = scrollEl.querySelectorAll<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (copies.length < 2) return copies[0] ?? null;
    return [...copies].find((el) => !hiddenCopy(el)) ?? copies[0];
  };
}

// Map a plain-text char offset within `el` to a concrete DOM (text node, offset)
// point, walking text nodes in document order. Clamps past-the-end to the last
// text node so a slightly-stale offset still yields a valid point.
export function domPointAtOffset(el: HTMLElement, offset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    last = node;
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
    node = walker.nextNode() as Text | null;
  }
  if (last) return { node: last, offset: last.data.length };
  return { node: el, offset: 0 };
}

export function findNearestTextOffset(
  haystack: string,
  needle: string,
  expectedOffset: number,
): number | null {
  if (!needle) return null;
  const expected = Number.isFinite(expectedOffset) ? Math.max(0, expectedOffset) : 0;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    const distance = Math.abs(index - expected);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    cursor = index + Math.max(1, needle.length);
  }
  return best;
}

export function anchorTextMatches(actual: string, expected: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const normalizedExpected = normalize(expected);
  return normalizedExpected.length > 0 && normalize(actual) === normalizedExpected;
}

function rangeForNeedle(el: HTMLElement, needle: string, expectedOffset: number): Range | null {
  const text = el.textContent ?? '';
  const i = findNearestTextOffset(text, needle, expectedOffset);
  if (i === null) return null;
  const start = domPointAtOffset(el, i);
  const end = domPointAtOffset(el, i + needle.length);
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

function rangeForTextAnchor(
  blockEl: BlockLookup,
  t: CommentTextAnchor,
  snapshots: { blockId: string | null; blockText: string }[],
): Range | null {
  const startEl = blockEl(t.startBlockId);
  const endEl = blockEl(t.endBlockId);
  if (!startEl || !endEl) return null;
  const start = domPointAtOffset(startEl, t.startOffset);
  const end = domPointAtOffset(endEl, t.endOffset);
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return t.startBlockId === t.endBlockId
      ? rangeForNeedle(startEl, t.text, t.startOffset)
      : null;
  }
  // A non-collapsed Range is not enough: edits before the anchor can leave the
  // old offsets pointing at unrelated prose. Never paint it unless the live
  // text still matches the captured selection.
  if (!range.collapsed && anchorTextMatches(range.toString(), t.text)) return range;

  if (t.startBlockId === t.endBlockId) {
    return rangeForNeedle(startEl, t.text, t.startOffset);
  }

  // For a cross-block selection, use the original block snapshots to recover
  // its first and last fragments. This handles text inserted before either
  // endpoint while keeping duplicate phrases tied to the nearest old offset.
  const startSnapshot = snapshots.find((snapshot) => snapshot.blockId === t.startBlockId);
  const endSnapshot = snapshots.find((snapshot) => snapshot.blockId === t.endBlockId);
  if (!startSnapshot || !endSnapshot) return null;
  const startNeedle = startSnapshot.blockText.slice(t.startOffset);
  const endNeedle = endSnapshot.blockText.slice(0, t.endOffset);
  if (!startNeedle || !endNeedle) return null;
  const relocatedStart = findNearestTextOffset(
    startEl.textContent ?? '',
    startNeedle,
    t.startOffset,
  );
  const relocatedEnd = findNearestTextOffset(endEl.textContent ?? '', endNeedle, 0);
  if (relocatedStart === null || relocatedEnd === null) return null;

  const nextStart = domPointAtOffset(startEl, relocatedStart);
  const nextEnd = domPointAtOffset(endEl, relocatedEnd + endNeedle.length);
  const relocated = document.createRange();
  try {
    relocated.setStart(nextStart.node, nextStart.offset);
    relocated.setEnd(nextEnd.node, nextEnd.offset);
  } catch {
    return null;
  }
  return !relocated.collapsed && anchorTextMatches(relocated.toString(), t.text)
    ? relocated
    : null;
}

function rangeForWholeBlock(el: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range;
}

/**
 * A comment's anchored region in the prose — a precise text span when the
 * comment carries a text anchor that still matches, else its whole block range.
 */
export function commentRanges(blockEl: BlockLookup, comment: Comment): Range[] {
  const textAnchor = getTextAnchorFromAnchor(comment.anchorJson);
  if (textAnchor) {
    const range = rangeForTextAnchor(
      blockEl,
      textAnchor,
      getBlockSnapshotsFromAnchor(comment.anchorJson),
    );
    if (range) return [range];
  }
  return commentBlockIds(comment).flatMap((id) => {
    const el = blockEl(id);
    return el ? [rangeForWholeBlock(el)] : [];
  });
}

/** Highlight names one comment paints: its resting wash, plus the active overlay. */
export function commentHighlightNames(comment: Comment, activeId: string | null): string[] {
  if (comment.status === 'converted') return [];
  const key = commentColorKey(comment);
  const names: string[] = [];
  const resting = comment.status === 'open' ? RESTING_HIGHLIGHT[key] : undefined;
  if (resting) names.push(resting);
  if (comment.id === activeId) names.push(ACTIVE_HIGHLIGHT[key]);
  return names;
}

export function sameRangeList<T>(
  a: readonly T[],
  b: readonly T[],
  same: (left: T, right: T) => boolean,
): boolean {
  return a.length === b.length && a.every((range, index) => same(range, b[index]));
}

// The comment whose Review or TODO card is under the pointer.
let activeCommentId: string | null = null;
const activeCommentListeners = new Set<() => void>();

export function setActiveCommentHighlight(id: string | null): void {
  if (activeCommentId === id) return;
  activeCommentId = id;
  activeCommentListeners.forEach((listener) => listener());
}

/** Clear the active comment only if it is still `id` (leave/unmount of its card). */
export function clearActiveCommentHighlight(id: string): void {
  if (activeCommentId === id) setActiveCommentHighlight(null);
}

export function getActiveCommentHighlight(): string | null {
  return activeCommentId;
}

export function subscribeActiveCommentHighlight(listener: () => void): () => void {
  activeCommentListeners.add(listener);
  return () => activeCommentListeners.delete(listener);
}

// The comment the author just went to: from its card or scroll tick, or by
// writing it. Its anchor is drawn again and stays strong until the
// author clicks or types in the prose, or selects another. Each selection
// carries a new nonce, so selecting the same comment again draws it again.
export interface SelectedCommentHighlight {
  id: string;
  nonce: number;
}
let selectedComment: SelectedCommentHighlight | null = null;
let selectionNonce = 0;
const selectedCommentListeners = new Set<() => void>();

export function selectCommentHighlight(id: string): void {
  selectionNonce += 1;
  selectedComment = { id, nonce: selectionNonce };
  selectedCommentListeners.forEach((listener) => listener());
}

export function clearSelectedCommentHighlight(): void {
  if (!selectedComment) return;
  selectedComment = null;
  selectedCommentListeners.forEach((listener) => listener());
}

export function getSelectedCommentHighlight(): SelectedCommentHighlight | null {
  return selectedComment;
}

export function subscribeSelectedCommentHighlight(listener: () => void): () => void {
  selectedCommentListeners.add(listener);
  return () => selectedCommentListeners.delete(listener);
}

// The comments whose anchors the pointer rests on in the prose (desktop): their
// cards light up as if pointed at. Empty when the pointer is on nothing.
const NO_POINTED_COMMENTS: readonly string[] = [];
let pointedCommentIds: readonly string[] = NO_POINTED_COMMENTS;
const pointedCommentListeners = new Set<() => void>();

export function setPointedCommentHighlights(ids: readonly string[]): void {
  const next = ids.length === 0 ? NO_POINTED_COMMENTS : ids;
  if (next.length === pointedCommentIds.length && next.every((id, index) => id === pointedCommentIds[index])) return;
  pointedCommentIds = next;
  pointedCommentListeners.forEach((listener) => listener());
}

export function getPointedCommentHighlights(): readonly string[] {
  return pointedCommentIds;
}

export function subscribePointedCommentHighlights(listener: () => void): () => void {
  pointedCommentListeners.add(listener);
  return () => pointedCommentListeners.delete(listener);
}
