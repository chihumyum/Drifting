// Paints the words the Agent just wrote (lib/agent-recent-changes.ts) in one
// editor scroller, as a colour through the CSS Custom Highlight API: no DOM is
// touched, so ProseMirror reconciliation and IME composition never see it.
// A mark is painted on its block's text at its stored offsets while the text
// there still matches (else at its nearest occurrence in the block); a block
// whose text no longer holds those words drops the mark. Resting the pointer on
// a mark for RECENT_CHANGE_DWELL_MS lets it go (its colour eases back in two
// steps). Each name is styled by a `::highlight(...)` rule in comments-review.css.
import { blockLookup, domPointAtOffset, findNearestTextOffset } from './comment-highlight';
import {
  dismissAgentRecentMark,
  forgetAgentRecentMarks,
  type AgentRecentMark,
} from './agent-recent-changes';
import { RECENT_CHANGE_DWELL_MS } from './motion';

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
  private point: { x: number; y: number } | null = null;
  private dwell: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

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
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.cancelDwell();
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
    if (this.dwell && !next.has(this.dwell.id)) this.cancelDwell();
    if (gone.length > 0) forgetAgentRecentMarks(gone);
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.painted.size === 0) return;
    this.point = { x: event.clientX, y: event.clientY };
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.hitTest();
    });
  };

  private readonly onPointerLeave = () => {
    this.point = null;
    this.cancelDwell();
  };

  /** Which shown mark the pointer rests on, if any; resting long enough lets it go. */
  private hitTest(): void {
    const point = this.point;
    let hit: Painted | null = null;
    if (point) {
      for (const painted of this.painted.values()) {
        if (painted.mark.fade) continue;
        for (const rect of painted.range.getClientRects()) {
          if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
            hit = painted;
            break;
          }
        }
        if (hit) break;
      }
    }
    if (hit?.mark.id === this.dwell?.id) return;
    this.cancelDwell();
    if (!hit) return;
    const id = hit.mark.id;
    this.dwell = { id, timer: setTimeout(() => {
      this.dwell = null;
      dismissAgentRecentMark(id);
    }, RECENT_CHANGE_DWELL_MS) };
  }

  private cancelDwell(): void {
    if (this.dwell) clearTimeout(this.dwell.timer);
    this.dwell = null;
  }
}
