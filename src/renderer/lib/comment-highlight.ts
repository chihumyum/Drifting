// In-prose hover highlight for comments, via the CSS Custom Highlight API
// (CSS.highlights + ::highlight()). Chosen over a CSS class on the block —
// ProseMirror strips externally-added `class` from the nodes it manages — and
// over WAAPI — which can only wash a whole element, not a sub-text span. A
// custom highlight paints an arbitrary DOM Range without mutating the DOM at
// all, so it (a) survives PM reconciliation and (b) supports fine-grained
// text-level anchoring (a comment pinned to a phrase highlights just that
// phrase; a whole-block anchor highlights the block).
//
// Colour is per source/kind (manual / copilot / todo) via three fixed
// highlight names, each styled by a `::highlight(...)` rule in index.css.
import {
  commentBlockIds,
  commentColorKey,
  getBlockSnapshotsFromAnchor,
  getTextAnchorFromAnchor,
  type Comment,
  type CommentTextAnchor,
} from '../domain/comment';

// The CSS Custom Highlight API isn't in every TS DOM lib version yet, so we
// feature-detect at runtime and type it locally rather than depend on globals.
interface HighlightLike {
  add(range: Range): void;
  delete(range: Range): boolean;
  readonly size: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  get(name: string): HighlightLike | undefined;
  delete(name: string): boolean;
}

const HIGHLIGHT_NAME: Record<string, string> = {
  todo: 'comment-hl-todo',
  manual: 'comment-hl-manual',
  copilot: 'comment-hl-copilot',
};

function getApi(): { Ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  if (!Ctor || !registry) return null;
  return { Ctor, registry };
}

function blockEl(scrollEl: HTMLElement, id: string): HTMLElement | null {
  return scrollEl.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
}

// Map a plain-text char offset within `el` to a concrete DOM (text node, offset)
// point, walking text nodes in document order. Clamps past-the-end to the last
// text node so a slightly-stale offset still yields a valid point.
function domPointAtOffset(el: HTMLElement, offset: number): { node: Node; offset: number } {
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
  scrollEl: HTMLElement,
  t: CommentTextAnchor,
  snapshots: { blockId: string | null; blockText: string }[],
): Range | null {
  const startEl = blockEl(scrollEl, t.startBlockId);
  const endEl = blockEl(scrollEl, t.endBlockId);
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
 * Highlight a comment's anchored region in the prose — a precise text span when
 * the comment carries a text anchor, else its whole block range. Returns a
 * dispose fn that removes exactly the ranges it added (and drops the highlight
 * name when empty). No-op (returns a noop dispose) when the API is unavailable
 * or nothing resolves.
 */
export function highlightComment(scrollEl: HTMLElement, comment: Comment): () => void {
  const api = getApi();
  if (!api) return () => {};
  const name = HIGHLIGHT_NAME[commentColorKey(comment)] ?? HIGHLIGHT_NAME.manual;

  const ranges: Range[] = [];
  const textAnchor = getTextAnchorFromAnchor(comment.anchorJson);
  if (textAnchor) {
    const r = rangeForTextAnchor(
      scrollEl,
      textAnchor,
      getBlockSnapshotsFromAnchor(comment.anchorJson),
    );
    if (r) ranges.push(r);
  }
  if (ranges.length === 0) {
    for (const id of commentBlockIds(comment)) {
      const el = blockEl(scrollEl, id);
      if (el) ranges.push(rangeForWholeBlock(el));
    }
  }
  if (ranges.length === 0) return () => {};

  const highlight = api.registry.get(name) ?? new api.Ctor();
  ranges.forEach((r) => highlight.add(r));
  api.registry.set(name, highlight);

  return () => {
    ranges.forEach((r) => highlight.delete(r));
    if (highlight.size === 0) api.registry.delete(name);
  };
}
