// In-prose comment anchors. This module resolves a comment's anchor to live
// DOM Ranges and keeps which comment is pointed at or selected; two painters
// draw the result. On the desktop, lib/comment-sand.ts draws each anchor as
// sand on a layer under the prose. The paused mobile shell keeps the painter
// below, via the CSS Custom Highlight API (CSS.highlights + ::highlight()).
// Both were chosen over a CSS class on the block — ProseMirror strips
// externally-added `class` from the nodes it manages — and over inline
// decorations, which split text nodes under IME composition. Neither mutates
// the prose DOM, so painting (a) survives PM reconciliation and (b) supports
// fine-grained text-level anchoring (a comment pinned to a phrase highlights
// just that phrase; a whole-block anchor highlights the block).
//
// Unresolved notes and TODOs keep a resting wash; Copilot proposals stay
// quiet. The comment whose Review or sticky card is hovered gets a stronger
// `-active` overlay. Each name is styled by a `::highlight(...)` rule in
// comments-review.css.
import {
  commentBlockIds,
  commentColorKey,
  getBlockSnapshotsFromAnchor,
  getTextAnchorFromAnchor,
  type Comment,
  type CommentColorKey,
  type CommentTextAnchor,
} from '../domain/comment';

// The CSS Custom Highlight API isn't in every TS DOM lib version yet, so we
// feature-detect at runtime and type it locally rather than depend on globals.
interface HighlightLike {
  add(range: Range): void;
  delete(range: Range): boolean;
  readonly size: number;
  priority?: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  get(name: string): HighlightLike | undefined;
  delete(name: string): boolean;
}

const RESTING_HIGHLIGHT: Partial<Record<CommentColorKey, string>> = {
  todo: 'comment-hl-todo',
  manual: 'comment-hl-manual',
};
const ACTIVE_HIGHLIGHT: Record<CommentColorKey, string> = {
  todo: 'comment-hl-todo-active',
  manual: 'comment-hl-manual-active',
  copilot: 'comment-hl-copilot-active',
};
const ACTIVE_HIGHLIGHT_NAMES = new Set(Object.values(ACTIVE_HIGHLIGHT));
// Paint the hovered anchor above overlapping resting washes.
const ACTIVE_HIGHLIGHT_PRIORITY = 1;
// Live Ranges follow most edits on their own; the delayed re-resolve repairs
// ranges whose text nodes ProseMirror re-rendered, without per-keystroke work.
const REPAINT_DELAY_MS = 150;
// Up to this many comments, look blocks up one by one; beyond it, index the
// scroller once (the whole-book reader can hold thousands of blocks).
const DIRECT_BLOCK_LOOKUP_LIMIT = 8;

function getApi(): { Ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  if (!Ctor || !registry) return null;
  return { Ctor, registry };
}

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

function sameRange(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

interface PaintedLayer {
  name: string;
  ranges: Range[];
}

function addLayer(api: { Ctor: HighlightCtor; registry: HighlightRegistryLike }, layer: PaintedLayer) {
  let highlight = api.registry.get(layer.name);
  if (!highlight) {
    highlight = new api.Ctor();
    if (ACTIVE_HIGHLIGHT_NAMES.has(layer.name)) highlight.priority = ACTIVE_HIGHLIGHT_PRIORITY;
    api.registry.set(layer.name, highlight);
  }
  for (const range of layer.ranges) highlight.add(range);
}

function removeLayer(registry: HighlightRegistryLike, layer: PaintedLayer) {
  const highlight = registry.get(layer.name);
  if (!highlight) return;
  for (const range of layer.ranges) highlight.delete(range);
  if (highlight.size === 0) registry.delete(layer.name);
}

/**
 * Paints the comment anchors of one editor scroller. A painter adds and removes
 * only its own ranges in the shared named highlights, so split panes and the
 * whole-book reader can show the same chapter independently. While attached it
 * re-resolves anchors after prose DOM mutations; detaching releases every range.
 */
export class CommentHighlightPainter {
  private comments: readonly Comment[] = [];
  private activeId: string | null = null;
  private painted = new Map<string, PaintedLayer>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly scrollEl: HTMLElement) {}

  attach(): () => void {
    if (!this.observer) {
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(this.scrollEl, { childList: true, subtree: true, characterData: true });
    }
    this.repaint();
    return () => this.detach();
  }

  update(comments: readonly Comment[], activeId: string | null): void {
    this.comments = comments;
    this.activeId = activeId;
    if (this.observer) this.repaint();
  }

  private detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const api = getApi();
    if (api) for (const layer of this.painted.values()) removeLayer(api.registry, layer);
    this.painted.clear();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.repaint();
    }, REPAINT_DELAY_MS);
  }

  private repaint(): void {
    const api = getApi();
    if (!api || (this.comments.length === 0 && this.painted.size === 0)) return;
    const lookup = blockLookup(this.scrollEl, this.comments);
    const next = new Map<string, PaintedLayer>();
    for (const comment of this.comments) {
      const names = commentHighlightNames(comment, this.activeId);
      if (names.length === 0) continue;
      const ranges = commentRanges(lookup, comment);
      if (ranges.length === 0) continue;
      for (const name of names) next.set(`${name}\u0000${comment.id}`, { name, ranges });
    }
    // Keep unchanged layers in place so an unrelated edit does not repaint them.
    for (const [key, layer] of this.painted) {
      const fresh = next.get(key);
      if (fresh && sameRangeList(layer.ranges, fresh.ranges, sameRange)) next.set(key, layer);
      else removeLayer(api.registry, layer);
    }
    for (const [key, layer] of next) {
      if (this.painted.get(key) !== layer) addLayer(api, layer);
    }
    this.painted = next;
  }
}

// The comment whose Review, sticky-note or TODO card is under the pointer.
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
// writing it. Its anchor is drawn again (desktop) and stays strong until the
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
