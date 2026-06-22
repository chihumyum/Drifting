// Whole-book find for the all-chapters read-through (通览全书). Unlike the
// single-editor Cmd+F (EditorFindPanel), which paints ProseMirror decorations on
// one live editor, this searches EVERY chapter — across the focused live editor,
// the static-HTML rows, and even rows scrolled out of view — and highlights via
// the CSS Custom Highlight API (the same mechanism comment-highlight.ts uses).
//
// Two halves:
//   1. Data layer (collectBookMatches): runs over each chapter's persisted
//      contentJson + its title/summary, so matches are found regardless of
//      whether a row has rendered yet. Match positions are expressed as
//      (container, occurrence) — the Nth case-insensitive hit of the query
//      inside a title / summary / prose block — NOT ProseMirror offsets. That
//      keeps the data layer and the DOM highlight layer in lockstep: both just
//      indexOf the same needle inside the same plain text, so there's no
//      PM-offset-vs-DOM-offset drift to reconcile.
//   2. View layer (applyBookFindHighlights): resolves each match to a DOM Range
//      inside the scroll container and registers it under one of two highlight
//      names (all matches vs. the current one).
//
// Scope is chapter prose only — element/storyline/category entities are the job
// of the global search modal (Cmd+Shift+F), never this panel.

// ---------------------------------------------------------------------------
// Match model
// ---------------------------------------------------------------------------

export type BookMatchKind = 'title' | 'summary' | 'body';

// A one-line context snippet around a hit, plus where the hit sits inside it so
// the results list can render the matched substring as a <mark>.
export interface Excerpt {
  text: string;
  matchStart: number;
  matchEnd: number;
}

export interface BookMatch {
  nodeId: string;
  // Position of the chapter in the read-through, for ordering + scroll targeting.
  chapterIndex: number;
  kind: BookMatchKind;
  // The prose block's id (kind === 'body' only); null for title/summary, which
  // are chrome elements without a block id.
  blockId: string | null;
  // Which occurrence of the query inside this container (0-based) — disambiguates
  // multiple hits in the same block/title/summary so the highlighter can target
  // the exact one.
  occurrence: number;
  // One-line context around the hit, for the results list.
  excerpt: Excerpt;
}

export interface ChapterDoc {
  nodeId: string;
  index: number;
  title: string;
  summary: string;
  contentJson: string | null;
}

// A single prose block's id + concatenated plain text. Mirrors what a
// `[data-block-id]` element's textContent holds in the DOM, so occurrence
// offsets line up.
interface BlockText {
  blockId: string | null;
  text: string;
}

interface PmNodeLike {
  type?: string;
  text?: string;
  attrs?: { id?: string | null } | null;
  content?: PmNodeLike[];
}

// Concatenate every descendant text node, in document order.
function textOf(node: PmNodeLike): string {
  if (typeof node.text === 'string') return node.text;
  if (!node.content) return '';
  let out = '';
  for (const child of node.content) out += textOf(child);
  return out;
}

// Walk the doc and emit one BlockText per outermost id-bearing block. We stop
// descending once a block id is found so nested blocks (a paragraph inside a
// blockquote) collapse into their ancestor — matching the DOM, where the
// ancestor `[data-block-id]` element's textContent already contains the child's
// text. Text outside any id-bearing block is ignored (chapters have none in
// practice).
function blocksOf(node: PmNodeLike, out: BlockText[]): void {
  const id = node.attrs?.id;
  if (typeof id === 'string' && id) {
    out.push({ blockId: id, text: textOf(node) });
    return;
  }
  if (!node.content) return;
  for (const child of node.content) blocksOf(child, out);
}

function parseBlocks(contentJson: string | null): BlockText[] {
  if (!contentJson) return [];
  let doc: PmNodeLike;
  try {
    doc = JSON.parse(contentJson) as PmNodeLike;
  } catch {
    return [];
  }
  const out: BlockText[] = [];
  blocksOf(doc, out);
  return out;
}

// Build a single-line context snippet around [at, at+len) and report where the
// hit lands inside it. Newlines become spaces (equal length, so offsets stay
// exact); other characters are kept verbatim so matchStart/End are precise.
//
// The snippet rows clip on the RIGHT only (text-overflow: ellipsis), so the hit
// must sit near the start to stay visible — hence only a little leading context
// (padBefore) and plenty of trailing (padAfter, fills the row, the rest clips).
export function makeExcerpt(text: string, at: number, len: number, padBefore = 10, padAfter = 60): Excerpt {
  const start = Math.max(0, at - padBefore);
  const end = Math.min(text.length, at + len + padAfter);
  const prefix = start > 0 ? '…' : '';
  const body = text.slice(start, end).replace(/\n/g, ' ');
  const matchStart = prefix.length + (at - start);
  return {
    text: prefix + body + (end < text.length ? '…' : ''),
    matchStart,
    matchEnd: matchStart + len,
  };
}

// Push every case-insensitive occurrence of `lowered` in `text` as a BookMatch.
// `occurrence` counts within this one container so the highlighter can re-find
// the exact hit.
function pushOccurrences(
  text: string,
  lowered: string,
  base: Omit<BookMatch, 'occurrence' | 'excerpt'>,
  acc: BookMatch[],
): void {
  if (!text) return;
  const hay = text.toLowerCase();
  let from = 0;
  let occurrence = 0;
  while (from <= hay.length - lowered.length) {
    const at = hay.indexOf(lowered, from);
    if (at < 0) break;
    acc.push({ ...base, occurrence, excerpt: makeExcerpt(text, at, lowered.length) });
    occurrence += 1;
    from = at + Math.max(1, lowered.length);
  }
}

/**
 * Collect every match of `query` across all chapters, in reading order:
 * chapter by chapter, and within a chapter title → summary → prose blocks (top
 * to bottom). The flat array is therefore already the navigation sequence used
 * by the find bar's prev/next.
 */
export function collectBookMatches(query: string, docs: ChapterDoc[]): BookMatch[] {
  const lowered = query.toLowerCase();
  if (!lowered) return [];
  const matches: BookMatch[] = [];
  for (const doc of docs) {
    pushOccurrences(doc.title, lowered, { nodeId: doc.nodeId, chapterIndex: doc.index, kind: 'title', blockId: null }, matches);
    pushOccurrences(doc.summary, lowered, { nodeId: doc.nodeId, chapterIndex: doc.index, kind: 'summary', blockId: null }, matches);
    for (const block of parseBlocks(doc.contentJson)) {
      pushOccurrences(
        block.text,
        lowered,
        { nodeId: doc.nodeId, chapterIndex: doc.index, kind: 'body', blockId: block.blockId },
        matches,
      );
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// View layer — CSS Custom Highlight API
// ---------------------------------------------------------------------------

// Feature-detected locally (the API isn't in every TS DOM lib yet), mirroring
// comment-highlight.ts.
interface HighlightLike {
  add(range: Range): void;
  clear(): void;
  readonly size: number;
}
type HighlightCtor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  get(name: string): HighlightLike | undefined;
  delete(name: string): boolean;
}

const HL_ALL = 'book-find';
const HL_CURRENT = 'book-find-current';

function getApi(): { Ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  if (!Ctor || !registry) return null;
  return { Ctor, registry };
}

// Map a plain-text char offset within `el` to a DOM (text node, offset) point,
// walking text nodes in document order. Clamps past-the-end to the last text
// node so a slightly-stale offset still yields a valid point.
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

// Locate the DOM element that holds a match's text: a prose block by id, or the
// chapter's title / summary chrome within its section.
export function containerForMatch(scrollEl: HTMLElement, match: BookMatch): HTMLElement | null {
  if (match.kind === 'body' && match.blockId) {
    return scrollEl.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(match.blockId)}"]`);
  }
  const section = scrollEl.querySelector<HTMLElement>(`[data-chapter-id="${CSS.escape(match.nodeId)}"]`);
  if (!section) return null;
  return section.querySelector<HTMLElement>(match.kind === 'title' ? '.page__title' : '.page__sub');
}

// Build a Range covering the `occurrence`-th case-insensitive hit of `needle`
// inside `el`. Returns null if the container doesn't (yet) hold that hit — e.g.
// a row whose prose hasn't rendered.
function rangeForMatch(el: HTMLElement, needle: string, occurrence: number): Range | null {
  const text = el.textContent ?? '';
  const hay = text.toLowerCase();
  const low = needle.toLowerCase();
  let from = 0;
  let seen = 0;
  let at = -1;
  while (from <= hay.length - low.length) {
    const i = hay.indexOf(low, from);
    if (i < 0) break;
    if (seen === occurrence) {
      at = i;
      break;
    }
    seen += 1;
    from = i + Math.max(1, low.length);
  }
  if (at < 0) return null;
  const start = domPointAtOffset(el, at);
  const end = domPointAtOffset(el, at + low.length);
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

// Cap on ranges materialised per repaint — a huge book × a one-letter query
// could otherwise build tens of thousands of ranges. The current match is
// always included even past the cap (it's resolved separately).
const MAX_HIGHLIGHT_RANGES = 3000;

/**
 * (Re)paint all currently-resolvable matches under the `book-find` highlight and
 * the current one under `book-find-current`, inside `scrollEl`. Always clears
 * first, so an empty query or no matches wipes any stale highlight. Matches
 * whose row hasn't rendered yet are silently skipped — calling again after a
 * scroll re-resolves them.
 */
export function applyBookFindHighlights(
  scrollEl: HTMLElement,
  query: string,
  matches: BookMatch[],
  currentIndex: number,
): void {
  const api = getApi();
  if (!api) return;

  const all = api.registry.get(HL_ALL) ?? new api.Ctor();
  const current = api.registry.get(HL_CURRENT) ?? new api.Ctor();
  all.clear();
  current.clear();

  if (query) {
    let painted = 0;
    for (let i = 0; i < matches.length; i++) {
      const isCurrent = i === currentIndex;
      if (!isCurrent && painted >= MAX_HIGHLIGHT_RANGES) continue;
      const el = containerForMatch(scrollEl, matches[i]);
      if (!el) continue;
      const range = rangeForMatch(el, query, matches[i].occurrence);
      if (!range) continue;
      if (isCurrent) current.add(range);
      else {
        all.add(range);
        painted += 1;
      }
    }
  }

  api.registry.set(HL_ALL, all);
  api.registry.set(HL_CURRENT, current);
}

/** Remove both find highlights from the global registry. */
export function clearBookFindHighlights(): void {
  const api = getApi();
  if (!api) return;
  api.registry.delete(HL_ALL);
  api.registry.delete(HL_CURRENT);
}
