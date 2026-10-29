// Comment anchors drawn in sand under the prose (desktop). Each anchor is a
// dry highlighter swash (sand/hl.png) laid under every line it runs over, in
// the comment's colour; see docs/design-system/materials.md, "砂笔进正文".
//
// The swash lives on a layer of its own inside the anchor's `.editor__spread`
// (one per chapter row in the whole-book reader), after the page: no text, no
// pointer, hidden from assistive technology and from selection, so the caret,
// selection, IME lookups and ProseMirror reconciliation never see it. It lies
// over the words but blends with them like pigment (multiply in light themes,
// screen in dark), so every word keeps its colour and an entity link's own
// sand shows through. A layer beneath the prose would not work: WebKit blends
// a link's sand only with what its own line painted, so the link's underline
// would blot out the comment's sand. The layer scrolls with the prose in the
// same native compositor transaction; there is no scroll listener.
//
// Geometry follows the prose on the next animation frame after any prose
// mutation, so the sand never trails the text while typing. Anchors are
// re-resolved from their stored offsets on the same delayed schedule as the
// mobile wash. In the whole-book reader only rows within a screen of the
// viewport are measured: reading line boxes inside a skipped
// `content-visibility` row would lay it out.
//
// Sand is an author's trace: only the author's own action draws it (selecting
// a comment draws its anchor again along the lines); everything else fades in
// or out as a whole, and pointing at a comment's card turns it to a sparser
// swash of the same grains, a little stronger (the CSS cross-fades the two).
import { commentColorKey, type Comment } from '../domain/comment';
import {
  blockLookup,
  clearSelectedCommentHighlight,
  commentHighlightNames,
  commentRanges,
  type SelectedCommentHighlight,
} from './comment-highlight';
import { SAND_DRAW_MS, SAND_DRAW_PER_LINE_MS, SAND_FADE_MS, sandDrawTimeAt } from './motion';

const LAYER_CLASS = 'comment-sand-layer';
// Live Ranges follow most edits on their own; the delayed re-resolve repairs
// ranges whose text nodes ProseMirror re-rendered, without per-keystroke work.
const RESOLVE_DELAY_MS = 150;
// The swash (720 × 64): a line shorter than its natural width is cut from the
// stroke's start, its last 12px thinning out; a longer line stretches it.
const SWASH_W = 720;
const SWASH_H = 64;
const SWASH_TAIL = 12;
// Rows within this much of the viewport (above and below) are measured.
const NEAR_MARGIN = '100% 0px';

interface LineBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Mark {
  id: string;
  group: HTMLDivElement;
  lines: HTMLDivElement[];
  boxes: LineBox[];
  host: HTMLElement | null;
  ranges: Range[];
  seed: number;
  /** The selection nonce this mark was last drawn for. */
  drawn: number;
  /** A selection still to draw once its lines are measured. */
  drawPending: boolean;
  leaving: ReturnType<typeof setTimeout> | null;
}

interface Host {
  el: HTMLElement;
  layer: HTMLDivElement;
  near: boolean;
  dirty: boolean;
}

function hashText(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The line boxes a set of ranges covers, merged per line, in `host` content coordinates. */
function lineBoxes(ranges: readonly Range[], host: HTMLElement, scratch: Range): LineBox[] {
  const origin = host.getBoundingClientRect();
  const left = origin.left + host.clientLeft - host.scrollLeft;
  const top = origin.top + host.clientTop - host.scrollTop;
  const lines: { mid: number; left: number; right: number; top: number; bottom: number }[] = [];
  const add = (rects: DOMRectList) => {
    for (const rect of rects) {
      if (rect.width < 1 || rect.height < 1) continue;
      const mid = rect.top + rect.height / 2;
      const line = lines.find((candidate) => Math.abs(candidate.mid - mid) < rect.height / 2);
      if (line) {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ mid, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
    }
  };
  for (const range of ranges) {
    // Measure text only: an element inside the range would report its whole
    // box (a block-level child spans the full column).
    const root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) {
      add(range.getClientRects());
      continue;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (!range.intersectsNode(node)) continue;
      scratch.setStart(node, node === range.startContainer ? range.startOffset : 0);
      scratch.setEnd(node, node === range.endContainer ? range.endOffset : node.data.length);
      if (!scratch.collapsed) add(scratch.getClientRects());
    }
  }
  return lines
    .sort((a, b) => a.top - b.top)
    .map((line) => ({
      // The swash reaches a little past the words on either side.
      x: Math.round(line.left - left - 3),
      y: Math.round(line.top - top - 1),
      w: Math.round(line.right - line.left + 6),
      h: Math.round(line.bottom - line.top + 3),
    }));
}

function sameBoxes(a: readonly LineBox[], b: readonly LineBox[]): boolean {
  return a.length === b.length &&
    a.every((box, index) => box.x === b[index].x && box.y === b[index].y && box.w === b[index].w && box.h === b[index].h);
}

/** How one line's swash fits: cut from the stroke's start (seeded per comment and line) or stretched. */
export function swashFit(width: number, height: number, seed: number): { size: number | null; x: number; tail: number } {
  const scale = height / SWASH_H;
  const natural = SWASH_W * scale;
  if (width >= natural) return { size: null, x: 0, tail: 0 };
  const source = width / scale;
  const offset = Math.floor(random(seed)() * Math.min(48, SWASH_W - source)) * scale;
  return { size: natural, x: -offset, tail: SWASH_TAIL };
}

function placeLine(el: HTMLDivElement, box: LineBox, seed: number) {
  const style = el.style;
  style.transform = `translate(${box.x}px, ${box.y}px)`;
  style.width = `${box.w}px`;
  style.height = `${box.h}px`;
  const fit = swashFit(box.w, box.h, seed);
  style.setProperty('--comment-sand-size', fit.size === null ? '100%' : `${fit.size.toFixed(1)}px`);
  style.setProperty('--comment-sand-x', `${fit.x.toFixed(1)}px`);
  style.setProperty('--comment-sand-tail', `${fit.tail}px`);
}

/** When each line's part of a redraw starts and how long it runs: one easing
 *  movement across all the lines, each line taking its share of the length. */
export function drawTimings(widths: readonly number[]): { delay: number; duration: number }[] {
  const total = widths.reduce((sum, width) => sum + width, 0);
  const whole = SAND_DRAW_MS + SAND_DRAW_PER_LINE_MS * Math.max(0, widths.length - 1);
  let before = 0;
  return widths.map((width) => {
    const start = total > 0 ? sandDrawTimeAt(before / total) * whole : 0;
    before += width;
    const end = total > 0 ? sandDrawTimeAt(before / total) * whole : whole;
    return { delay: start, duration: Math.max(1, end - start) };
  });
}

/** Draw the stroke again along its lines. */
function drawLines(lines: readonly HTMLDivElement[], boxes: readonly LineBox[]) {
  if (reducedMotion() || lines.length === 0 || typeof lines[0].animate !== 'function') return;
  drawTimings(boxes.map((box) => box.w)).forEach(({ delay, duration }, index) => {
    const line = lines[index];
    line.getAnimations().forEach((animation) => animation.cancel());
    line.animate(
      [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
      { duration, delay, easing: 'linear', fill: 'backwards' },
    );
  });
}

/**
 * Paints the comment anchors of one editor scroller in sand. While attached it
 * follows prose mutations, size changes and which rows are near the viewport;
 * detaching only stops following (a hidden keep-alive surface keeps its sand
 * for when it shows again), and disposing removes every layer.
 */
export class CommentSandPainter {
  private comments: readonly Comment[] = [];
  private activeId: string | null = null;
  private selected: SelectedCommentHighlight | null = null;
  private marks = new Map<string, Mark>();
  private hosts = new Map<HTMLElement, Host>();
  private attached = false;
  private mutation: MutationObserver | null = null;
  private resize: ResizeObserver | null = null;
  private near: IntersectionObserver | null = null;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private readonly scratch = document.createRange();

  constructor(private readonly scrollEl: HTMLElement) {}

  attach(): () => void {
    if (!this.attached) {
      this.attached = true;
      this.mutation = new MutationObserver((records) => this.onMutations(records));
      // `aria-hidden` flips when the whole-book reader swaps a chapter's static
      // copy for its live editor: the anchors move to the copy now shown.
      this.mutation.observe(this.scrollEl, {
        childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-hidden'],
      });
      if (typeof ResizeObserver === 'function') {
        this.resize = new ResizeObserver((entries) => {
          for (const entry of entries) this.markDirty(entry.target as HTMLElement);
        });
      }
      // Without IntersectionObserver every host counts as near.
      if (typeof IntersectionObserver === 'function') {
        this.near = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const host = this.hosts.get(entry.target as HTMLElement);
            if (!host) continue;
            host.near = entry.isIntersecting;
            if (host.near) this.markDirty(host.el);
          }
        }, { root: this.scrollEl, rootMargin: NEAR_MARGIN });
      }
      for (const host of this.hosts.values()) this.watch(host);
      this.scrollEl.addEventListener('pointerdown', this.onPointerDown, true);
      this.scrollEl.addEventListener('beforeinput', this.onBeforeInput, true);
      document.fonts?.addEventListener?.('loadingdone', this.onFontsLoaded);
    }
    this.resolve();
    return () => this.detach();
  }

  update(comments: readonly Comment[], activeId: string | null, selected: SelectedCommentHighlight | null): void {
    this.comments = comments;
    this.activeId = activeId;
    this.selected = selected;
    if (this.attached) this.resolve();
  }

  dispose(): void {
    this.detach();
    for (const mark of this.marks.values()) if (mark.leaving) clearTimeout(mark.leaving);
    this.marks.clear();
    for (const host of this.hosts.values()) host.layer.remove();
    this.hosts.clear();
  }

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.mutation?.disconnect();
    this.resize?.disconnect();
    this.near?.disconnect();
    this.mutation = this.resize = this.near = null;
    if (this.resolveTimer !== null) clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.scrollEl.removeEventListener('pointerdown', this.onPointerDown, true);
    this.scrollEl.removeEventListener('beforeinput', this.onBeforeInput, true);
    document.fonts?.removeEventListener?.('loadingdone', this.onFontsLoaded);
  }

  // Clicking into the prose or typing ends a selection: the anchor eases back.
  private readonly onPointerDown = (event: PointerEvent) => {
    if (this.selected && event.target instanceof Element && event.target.closest('[data-block-id]')) {
      clearSelectedCommentHighlight();
    }
  };

  private readonly onBeforeInput = () => {
    if (this.selected) clearSelectedCommentHighlight();
  };

  private readonly onFontsLoaded = () => {
    for (const host of this.hosts.values()) this.markDirty(host.el);
  };

  private onMutations(records: MutationRecord[]): void {
    let prose = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest(`.${LAYER_CLASS}`)) continue;
      prose = true;
      const host = this.hostElementFor(target);
      if (host) this.markDirty(host);
    }
    if (!prose) return;
    if (this.resolveTimer !== null) clearTimeout(this.resolveTimer);
    this.resolveTimer = setTimeout(() => {
      this.resolveTimer = null;
      this.resolve();
    }, RESOLVE_DELAY_MS);
  }

  private hostElementFor(node: Node): HTMLElement | null {
    const element = node instanceof Element ? node : node.parentElement;
    const spread = element?.closest<HTMLElement>('.editor__spread');
    if (spread && this.scrollEl.contains(spread)) return spread;
    return element && this.scrollEl.contains(element) ? this.scrollEl : null;
  }

  private hostFor(el: HTMLElement): Host {
    const known = this.hosts.get(el);
    if (known && known.layer.parentElement === el) return known;
    const layer = known?.layer ?? document.createElement('div');
    layer.className = LAYER_CLASS;
    layer.setAttribute('aria-hidden', 'true');
    el.append(layer);
    // Until the observer reports, only the scroller itself counts as near.
    const host: Host = { el, layer, near: known?.near ?? el === this.scrollEl, dirty: true };
    this.hosts.set(el, host);
    if (this.attached) this.watch(host);
    return host;
  }

  private watch(host: Host): void {
    this.resize?.observe(host.el);
    if (host.el === this.scrollEl || !this.near) host.near = true;
    else this.near.observe(host.el);
  }

  private markDirty(el: HTMLElement): void {
    const host = this.hosts.get(el);
    if (!host) return;
    host.dirty = true;
    if (host.near && !this.frame && this.attached) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.measure();
      });
    }
  }

  /** Match each comment to its anchor's live ranges and keep the set of marks in step. */
  private resolve(): void {
    if (this.comments.length === 0 && this.marks.size === 0) return;
    const lookup = blockLookup(this.scrollEl, this.comments);
    const wanted = new Set<string>();
    for (const comment of this.comments) {
      const selected = this.selected?.id === comment.id;
      const hot = selected || this.activeId === comment.id;
      if (commentHighlightNames(comment, hot ? comment.id : null).length === 0) continue;
      const ranges = commentRanges(lookup, comment);
      const hostEl = ranges.length > 0 ? this.hostElementFor(ranges[0].startContainer) : null;
      if (!hostEl) continue;
      wanted.add(comment.id);
      let mark = this.marks.get(comment.id);
      if (!mark) {
        const group = document.createElement('div');
        mark = {
          id: comment.id, group, lines: [], boxes: [], host: null, ranges: [], seed: hashText(comment.id),
          drawn: 0, drawPending: false, leaving: null,
        };
        this.marks.set(comment.id, mark);
      }
      if (mark.leaving) {
        clearTimeout(mark.leaving);
        mark.leaving = null;
      }
      const host = this.hostFor(hostEl);
      if (mark.group.parentElement !== host.layer) host.layer.append(mark.group);
      if (mark.host !== hostEl) {
        mark.host = hostEl;
        mark.boxes = [];
      }
      mark.ranges = ranges;
      const className = `comment-sand comment-sand--${commentColorKey(comment)}`;
      if (mark.group.className !== className) mark.group.className = className;
      const state = hot ? 'hot' : 'rest';
      if (mark.group.dataset.state !== state) mark.group.dataset.state = state;
      if (selected && mark.drawn !== this.selected!.nonce) mark.drawPending = true;
      this.markDirty(hostEl);
    }
    for (const mark of this.marks.values()) {
      if (wanted.has(mark.id) || mark.leaving) continue;
      // Gone (resolved, deleted, its text removed): fade out as a whole.
      mark.group.dataset.state = 'gone';
      mark.leaving = setTimeout(() => {
        mark.group.remove();
        this.marks.delete(mark.id);
      }, reducedMotion() ? 0 : SAND_FADE_MS);
    }
    // A row the reader re-created leaves its old spread (and layer) behind.
    for (const [el, host] of this.hosts) {
      if (el.isConnected) continue;
      this.resize?.unobserve(el);
      this.near?.unobserve(el);
      host.layer.remove();
      this.hosts.delete(el);
    }
  }

  /** Re-read the line boxes of every dirty, near host and move its sand to match. */
  private measure(): void {
    for (const host of this.hosts.values()) {
      if (!host.dirty || !host.near) continue;
      host.dirty = false;
      if (!host.el.isConnected) continue;
      for (const mark of this.marks.values()) {
        if (mark.host !== host.el || mark.leaving) continue;
        const live = mark.ranges.filter((range) => range.startContainer.isConnected && !range.collapsed);
        const boxes = live.length > 0 ? lineBoxes(live, host.el, this.scratch) : [];
        if (!sameBoxes(boxes, mark.boxes)) {
          while (mark.lines.length > boxes.length) mark.lines.pop()!.remove();
          while (mark.lines.length < boxes.length) {
            const line = document.createElement('div');
            line.className = 'comment-sand__line';
            mark.group.append(line);
            mark.lines.push(line);
          }
          boxes.forEach((box, index) => placeLine(mark.lines[index], box, mark.seed + index * 7919));
          mark.boxes = boxes;
        }
        if (mark.drawPending && boxes.length > 0 && this.selected?.id === mark.id) {
          mark.drawPending = false;
          mark.drawn = this.selected.nonce;
          drawLines(mark.lines, boxes);
        }
      }
    }
  }
}
