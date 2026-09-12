import type { FlatOutlineEntry } from './outline-rail-model';

export interface RailGeometry {
  offsets: Record<string, number>;
  bottoms: Record<string, number>;
  fractions: Record<string, number>;
  contentHeight: number;
  clientHeight: number;
  scrollTop: number;
}

const EMPTY_GEOMETRY: RailGeometry = {
  offsets: {},
  bottoms: {},
  fractions: {},
  contentHeight: 1,
  clientHeight: 1,
  scrollTop: 0,
};

function selectorEscape(value: string): string {
  return typeof CSS !== 'undefined' && 'escape' in CSS
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

function resolveAnchor(scrollEl: HTMLElement, entry: FlatOutlineEntry): HTMLElement | null {
  const escaped = selectorEscape(entry.id);
  if (entry.item.kind === 'act') {
    const rawId = entry.id.startsWith('act:') ? entry.id.slice(4) : entry.id;
    return scrollEl.querySelector<HTMLElement>(`[data-act-id="${selectorEscape(rawId)}"]`);
  }
  if (entry.item.kind === 'chapter') {
    return scrollEl.querySelector<HTMLElement>(`[data-chapter-id="${escaped}"]`);
  }
  if (entry.item.kind === 'section') {
    return scrollEl.querySelector<HTMLElement>(`#${escaped}`);
  }
  return (
    scrollEl.querySelector<HTMLElement>(`[data-block-id="${escaped}"]`) ??
    scrollEl.querySelector<HTMLElement>(`#${escaped}`)
  );
}

function sameGeometry(a: RailGeometry, b: RailGeometry): boolean {
  if (
    Math.abs(a.contentHeight - b.contentHeight) > 0.5 ||
    Math.abs(a.clientHeight - b.clientHeight) > 0.5 ||
    Math.abs(a.scrollTop - b.scrollTop) > 0.5
  ) {
    return false;
  }
  const aKeys = Object.keys(a.offsets);
  const bKeys = Object.keys(b.offsets);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Math.abs(a.offsets[key] - b.offsets[key]) <= 0.5 &&
      Math.abs(a.bottoms[key] - b.bottoms[key]) <= 0.5 &&
      Math.abs(a.fractions[key] - b.fractions[key]) <= 0.0005,
  );
}

export const EMPTY_OUTLINE_VIEWPORT = { geometry: EMPTY_GEOMETRY, railHeight: 0, primaryId: null as string | null };

/** One visible rail owns geometry and reading location for its scroll viewport. */
export class OutlineViewportController {
  private attached = false;
  private listening = false;
  private needed = false;
  private dirty = true;
  private frame = 0;
  private entries: FlatOutlineEntry[] = [];
  private readingIds: readonly string[] = [];
  private key = '';
  private pinned: string | null = null;
  private resize: ResizeObserver | null = null;
  private mutation: MutationObserver | null = null;
  private children = new Set<Element>();
  private snapshot = EMPTY_OUTLINE_VIEWPORT;
  private listeners = new Set<() => void>();

  constructor(readonly root: HTMLElement, private readonly rail: HTMLElement, private readonly body: HTMLElement) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  configure(entries: FlatOutlineEntry[], readingIds?: readonly string[]): void {
    const key = JSON.stringify([entries.map(e => [e.id, e.item.kind]), readingIds ?? []]);
    this.entries = entries;
    this.readingIds = readingIds ?? [];
    if (key === this.key) return;
    this.key = key;
    this.dirty = true;
  }

  attach(): () => void {
    if (this.attached) throw new Error('Outline viewport already attached');
    this.attached = true;
    if (this.needed) this.resume();
    return this.dispose;
  }

  setPresentationNeeded(needed: boolean): void {
    this.needed = needed;
    if (needed && this.attached) {
      this.resume();
      if (this.dirty) this.measure();
    } else this.pause();
  }

  private syncChildren(): void {
    const next = new Set(this.root.children);
    for (const child of this.children) if (!next.has(child)) this.resize?.unobserve(child);
    for (const child of next) if (!this.children.has(child)) this.resize?.observe(child);
    this.children = next;
  }

  private resume(): void {
    if (this.listening) return;
    this.listening = true;
    this.dirty = true;
    this.resize = new ResizeObserver(this.invalidate);
    for (const element of new Set([this.root, this.rail, this.body])) this.resize.observe(element);
    this.syncChildren();
    this.mutation = new MutationObserver(() => {
      if (!this.listening) return;
      this.syncChildren();
      this.invalidate();
    });
    this.mutation.observe(this.root, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['id', 'data-block-id', 'data-chapter-id', 'data-act-id'] });
    this.root.addEventListener('scroll', this.schedule, { passive: true });
    window.addEventListener('resize', this.invalidate);
    // Called from layout preparation, before an incoming surface is painted.
    this.measure();
  }

  private invalidate = (): void => {
    if (!this.listening) return;
    this.dirty = true;
    this.schedule();
  };
  private schedule = (): void => {
    if (!this.listening || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  };

  private readingLocation(geometry: RailGeometry): string | null {
    if (this.pinned) {
      const id = this.pinned;
      if (this.readingIds.includes(id) && geometry.bottoms[id] > geometry.scrollTop &&
          geometry.offsets[id] < geometry.scrollTop + geometry.clientHeight) return id;
      this.pinned = null;
    }
    const readingLine = geometry.scrollTop + 80;
    let best: string | null = null;
    let distance = Infinity;
    for (const id of this.readingIds) {
      const top = geometry.offsets[id];
      if (top <= readingLine + 24 && readingLine - top < distance) {
        distance = readingLine - top;
        best = id;
      }
    }
    return best ?? this.readingIds[0] ?? null;
  }

  private measure(): void {
    if (!this.listening) return;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const previous = this.snapshot;
    const scrollTop = this.root.scrollTop;
    const clientHeight = Math.max(1, this.root.clientHeight);
    const contentHeight = Math.max(1, this.root.scrollHeight);
    let { offsets, bottoms, fractions } = previous.geometry;
    if (this.dirty || clientHeight !== previous.geometry.clientHeight || contentHeight !== previous.geometry.contentHeight) {
      const rootTop = this.root.getBoundingClientRect().top;
      offsets = {}; bottoms = {}; fractions = {};
      const bounds = new Map<HTMLElement, DOMRect>();
      for (const entry of this.entries) {
        const anchor = resolveAnchor(this.root, entry);
        if (!anchor) continue;
        let rect = bounds.get(anchor);
        if (!rect) { rect = anchor.getBoundingClientRect(); bounds.set(anchor, rect); }
        const top = rect.top - rootTop + scrollTop;
        offsets[entry.id] = top;
        bottoms[entry.id] = rect.bottom - rootTop + scrollTop;
        fractions[entry.id] = Math.min(1, Math.max(0, top / contentHeight));
      }
      this.dirty = false;
    }
    const geometry = { offsets, bottoms, fractions, scrollTop, clientHeight, contentHeight };
    const primaryId = this.readingLocation(geometry);
    const railHeight = this.rail.clientHeight;
    if (primaryId === previous.primaryId && railHeight === previous.railHeight && sameGeometry(geometry, previous.geometry)) return;
    this.snapshot = { geometry, primaryId, railHeight };
    for (const listener of this.listeners) listener();
  }

  pin = (id: string): void => {
    if (!this.listening || !this.readingIds.includes(id)) return;
    this.pinned = id;
    if (this.snapshot.primaryId === id) return;
    this.snapshot = { ...this.snapshot, primaryId: id };
    for (const listener of this.listeners) listener();
  };

  private pause(): void {
    if (this.listening) {
      this.listening = false;
      this.root.removeEventListener('scroll', this.schedule);
      window.removeEventListener('resize', this.invalidate);
    }
    this.resize?.disconnect(); this.resize = null;
    this.mutation?.disconnect(); this.mutation = null;
    this.children.clear();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.dirty = true;
  }
  private dispose = (): void => {
    this.pause();
    this.attached = false;
  };
}
