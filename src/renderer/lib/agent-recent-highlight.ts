// Paints the words the Agent just wrote (lib/agent-recent-changes.ts) in one
// editor scroller, as a colour through the CSS Custom Highlight API: no DOM is
// touched, so ProseMirror reconciliation and IME composition never see it.
// A mark is painted on its block's text at its stored offsets while the text
// there still matches (else at its nearest occurrence in the block); a block
// whose text no longer holds those words drops the mark. The pointer touching a
// mark lets it go at once (its colour eases back in two steps), whether the
// pointer moves onto the words or the words scroll under a pointer held still:
// everything the pointer passes over between two frames counts, so a quick
// flick leaves no gaps. Each name is styled by a `::highlight(...)` rule in
// comments-review.css.
import { blockLookup, domPointAtOffset, findNearestTextOffset } from './comment-highlight';
import {
  dismissAgentRecentMark,
  forgetAgentRecentMarks,
  type AgentRecentMark,
} from './agent-recent-changes';

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

function getApi(): { Ctor: HighlightCtor; registry: HighlightRegistryLike } | null {
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = typeof CSS === 'undefined' ? undefined : (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  return Ctor && registry ? { Ctor, registry } : null;
}

const REPAINT_DELAY_MS = 150;

interface Point {
  x: number;
  y: number;
}

/** Whether the pointer's path from `a` to `b` crosses `rect`, edges included
 * (Liang–Barsky clipping; a path of one point is a plain containment test). */
export function pathTouchesRect(
  a: Point,
  b: Point,
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let enter = 0;
  let exit = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > exit) return false;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return false;
      if (t < exit) exit = t;
    }
    return true;
  };
  return clip(-dx, a.x - rect.left) && clip(dx, rect.right - a.x)
    && clip(-dy, a.y - rect.top) && clip(dy, rect.bottom - a.y);
}

/** Where the last frame's check left the pointer, seen in this frame: the path
 * since then, or just the pointer when the content leapt (a search result, a
 * contents link — further than half the scroller in one frame), since words a
 * jump skips never passed under the pointer. */
export function pointerPathStart(
  trail: Point | null,
  point: Point,
  scroll: { left: number; top: number; height: number },
): Point {
  if (!trail) return point;
  const from = { x: trail.x - scroll.left, y: trail.y - scroll.top };
  return Math.hypot(point.x - from.x, point.y - from.y) > scroll.height / 2 ? point : from;
}

/** The highlight a mark paints into: its kind, and how far it has faded. */
export function agentRecentHighlightName(mark: Pick<AgentRecentMark, 'kind' | 'fade'>): string {
  return `agent-recent-${mark.kind}${mark.fade ? `-${mark.fade}` : ''}`;
}

interface Painted {
  name: string;
  range: Range;
  mark: AgentRecentMark;
}

function rangeFor(block: HTMLElement, mark: AgentRecentMark): Range | null {
  const text = block.textContent ?? '';
  let start = mark.start;
  if (text.slice(mark.start, mark.end) !== mark.text) {
    const found = findNearestTextOffset(text, mark.text, mark.start);
    if (found === null) return null;
    start = found;
  }
  const from = domPointAtOffset(block, start);
  const to = domPointAtOffset(block, start + mark.text.length);
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

export class AgentRecentHighlightPainter {
  private marks: readonly AgentRecentMark[] = [];
  private painted = new Map<string, Painted>();
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  /** The pointer over the scroller, in the viewport. */
  private point: Point | null = null;
  /** Where the last check left the pointer, in the scroller's content, so a
   * scroll under a still pointer sweeps the words it carried past. */
  private trail: Point | null = null;

  constructor(
    private readonly scrollEl: HTMLElement,
    private readonly owns: (mark: AgentRecentMark) => boolean,
  ) {}

  attach(): () => void {
    if (!this.observer) {
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(this.scrollEl, {
        childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-hidden'],
      });
      this.scrollEl.addEventListener('pointermove', this.onPointerMove, { passive: true });
      this.scrollEl.addEventListener('pointerleave', this.onPointerLeave);
      this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
    }
    this.repaint();
    return () => this.detach();
  }

  update(marks: readonly AgentRecentMark[]): void {
    this.marks = marks.filter(this.owns);
    if (this.observer) this.repaint();
  }

  private detach(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.scrollEl.removeEventListener('pointermove', this.onPointerMove);
    this.scrollEl.removeEventListener('pointerleave', this.onPointerLeave);
    this.scrollEl.removeEventListener('scroll', this.onScroll);
    this.point = null;
    this.trail = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const api = getApi();
    if (api) for (const painted of this.painted.values()) this.remove(api, painted);
    this.painted.clear();
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.repaint();
    }, REPAINT_DELAY_MS);
  }

  private add(api: { Ctor: HighlightCtor; registry: HighlightRegistryLike }, painted: Painted) {
    let highlight = api.registry.get(painted.name);
    if (!highlight) {
      highlight = new api.Ctor();
      api.registry.set(painted.name, highlight);
    }
    highlight.add(painted.range);
  }

  private remove(api: { registry: HighlightRegistryLike }, painted: Painted) {
    const highlight = api.registry.get(painted.name);
    if (!highlight) return;
    highlight.delete(painted.range);
    if (highlight.size === 0) api.registry.delete(painted.name);
  }

  private repaint(): void {
    const api = getApi();
    if (!api || (this.marks.length === 0 && this.painted.size === 0)) return;
    const lookup = blockLookup(this.scrollEl, this.marks);
    const next = new Map<string, Painted>();
    const gone: string[] = [];
    for (const mark of this.marks) {
      const block = lookup(mark.blockId);
      // A block not rendered here (another chapter, not loaded yet) keeps its mark.
      if (!block) continue;
      const known = this.painted.get(mark.id);
      const name = agentRecentHighlightName(mark);
      const fresh = known && known.range.toString() === mark.text ? known.range : rangeFor(block, mark);
      if (!fresh) { gone.push(mark.id); continue; }
      next.set(mark.id, { name, range: fresh, mark });
    }
    for (const [id, painted] of this.painted) {
      const now = next.get(id);
      if (!now || now.range !== painted.range || now.name !== painted.name) this.remove(api, painted);
    }
    for (const [id, painted] of next) {
      const before = this.painted.get(id);
      if (!before || before.range !== painted.range || before.name !== painted.name) this.add(api, painted);
    }
    this.painted = next;
    // Marks that appear under a still pointer stay until it or the page moves;
    // start the path where the pointer rests now.
    if (this.painted.size > 0 && this.point && !this.trail) this.trail = this.inContent(this.point);
    if (gone.length > 0) forgetAgentRecentMarks(gone);
  }

  private inContent(point: Point): Point {
    return { x: point.x + this.scrollEl.scrollLeft, y: point.y + this.scrollEl.scrollTop };
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.point = { x: event.clientX, y: event.clientY };
    this.request();
  };

  private readonly onScroll = () => {
    if (this.point) this.request();
  };

  private readonly onPointerLeave = () => {
    this.point = null;
    this.trail = null;
  };

  private request(): void {
    if (this.painted.size === 0) {
      this.trail = null;
      return;
    }
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.hitTest();
    });
  }

  /** Lets go of every shown mark the pointer passed over since the last frame. */
  private hitTest(): void {
    const point = this.point;
    if (!point || this.painted.size === 0) {
      this.trail = null;
      return;
    }
    const { scrollLeft, scrollTop, clientHeight } = this.scrollEl;
    const from = pointerPathStart(this.trail, point, { left: scrollLeft, top: scrollTop, height: clientHeight });
    this.trail = { x: point.x + scrollLeft, y: point.y + scrollTop };
    const touched: string[] = [];
    for (const painted of this.painted.values()) {
      if (painted.mark.fade) continue;
      for (const rect of painted.range.getClientRects()) {
        if (pathTouchesRect(from, point, rect)) {
          touched.push(painted.mark.id);
          break;
        }
      }
    }
    for (const id of touched) dismissAgentRecentMark(id);
  }
}
