import { EMPTY_SCROLL_MARKERS, sameScrollMarkers, scrollMarkerBlockSelector, type ScrollMarker, type ScrollMarkerTick } from './scroll-marker-model';

/** Presentation only. Pending review state, masks and decisions have other owners. */
export class ScrollMarkerViewportController {
  private attached = false;
  private needed = false;
  private listening = false;
  private dirty = true;
  private frame = 0;
  private markers: readonly ScrollMarker[] = EMPTY_SCROLL_MARKERS;
  private snapshot: readonly ScrollMarkerTick[] = EMPTY_SCROLL_MARKERS;
  private listeners = new Set<() => void>();
  private resize: ResizeObserver | null = null;
  private mutation: MutationObserver | null = null;
  private targets = new Set<Element>();

  constructor(readonly root: HTMLElement) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  attach(): () => void {
    if (this.attached) throw new Error('Scroll marker viewport already attached');
    this.attached = true;
    this.prepare();
    return this.dispose;
  }
  configure(markers: readonly ScrollMarker[]): void {
    if (sameScrollMarkers(this.markers, markers)) return;
    this.markers = markers;
    this.dirty = true;
  }
  setPresentationNeeded(needed: boolean): void {
    this.needed = needed;
    this.prepare();
  }
  private prepare(): void {
    if (!this.attached || !this.needed || this.markers.length === 0) {
      this.pause();
      if (this.markers.length === 0) this.publish(EMPTY_SCROLL_MARKERS);
      return;
    }
    this.resume();
    // Layout preparation refreshes incoming anchors before paint even when
    // this surface was hidden during document/data changes.
    if (this.dirty) this.measure();
  }
  private resume(): void {
    if (this.listening) return;
    this.listening = true;
    this.dirty = true;
    this.resize = new ResizeObserver(this.invalidate);
    this.mutation = new MutationObserver(records => {
      // Root style controls the virtual typewriter tail (scrollHeight can
      // change without a content-box resize). Ignore descendant style churn.
      if (records.some(record => record.type !== 'attributes' || record.attributeName === 'data-block-id' || record.target === this.root)) this.invalidate();
    });
    this.mutation.observe(this.root, { childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['data-block-id', 'style', 'data-typewriter-scroll'] });
    window.addEventListener('resize', this.invalidate);
    this.root.addEventListener('load', this.invalidate, true);
  }
  private invalidate = (): void => {
    if (!this.listening) return;
    this.dirty = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  };
  private measure(): void {
    if (!this.listening) return;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const rootTop = this.root.getBoundingClientRect().top;
    const scrollTop = this.root.scrollTop;
    const height = Math.max(1, this.root.scrollHeight);
    const anchors = new Map<string, HTMLElement | null>();
    const fractions = new Map<HTMLElement, number>();
    const next: ScrollMarkerTick[] = [];
    for (const marker of this.markers) {
      let first: HTMLElement | null = null;
      for (const id of marker.blockIds) {
        if (!anchors.has(id)) anchors.set(id, this.root.querySelector<HTMLElement>(scrollMarkerBlockSelector(id)));
        first = anchors.get(id) ?? null;
        if (first) break;
      }
      if (!first && marker.blockIds.length) continue;
      let frac = 0;
      if (first) {
        let cached = fractions.get(first);
        if (cached === undefined) {
          const top = first.getBoundingClientRect().top;
          cached = Math.min(1, Math.max(0, (top - rootTop + scrollTop) / height));
          fractions.set(first, cached);
        }
        frac = cached;
      }
      next.push({ ...marker, frac });
    }
    // Track replacements without retaining removed content or anchor nodes.
    const targets = new Set<Element>([this.root, ...this.root.children, ...fractions.keys()]);
    const page = this.root.querySelector('.page');
    if (page) targets.add(page);
    for (const element of this.targets) if (!targets.has(element)) this.resize?.unobserve(element);
    for (const element of targets) if (!this.targets.has(element)) this.resize?.observe(element);
    this.targets = targets;
    this.dirty = false;
    next.sort((a, b) => a.frac - b.frac);
    this.publish(next);
  }
  private publish(next: readonly ScrollMarkerTick[]): void {
    if (sameScrollMarkers(this.snapshot, next) && this.snapshot.every((tick, index) => Math.abs(tick.frac - next[index].frac) <= 0.001)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private pause(): void {
    if (this.listening) {
      this.listening = false;
      window.removeEventListener('resize', this.invalidate);
      this.root.removeEventListener('load', this.invalidate, true);
    }
    this.resize?.disconnect(); this.resize = null;
    this.mutation?.disconnect(); this.mutation = null;
    this.targets.clear();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.dirty = true;
  }
  private dispose = (): void => {
    this.pause();
    this.attached = false;
  };
}
