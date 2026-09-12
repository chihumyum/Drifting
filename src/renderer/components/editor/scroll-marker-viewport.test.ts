import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollMarkerViewportController } from './scroll-marker-viewport';
import type { ScrollMarker } from './scroll-marker-model';

const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
class Target extends EventTarget {
  listeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(name: string, fn: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) { if (fn) this.listeners.add(fn); super.addEventListener(name, fn, options); }
  override removeEventListener(name: string, fn: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) { if (fn) this.listeners.delete(fn); super.removeEventListener(name, fn, options); }
}
class Resize {
  static all: Resize[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: () => void) { Resize.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
}
class Mutation {
  static all: Mutation[] = [];
  active = false;
  callback: (records?: MutationRecord[]) => void;
  constructor(notify: (records: MutationRecord[]) => void) { this.callback = (records = [{ type: 'childList' } as MutationRecord]) => notify(records); Mutation.all.push(this); }
  observe() { this.active = true; }
  disconnect() { this.active = false; }
}
function paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); }
const marker = (key: string, blockIds: string[]): ScrollMarker => ({ key, blockIds, cls: 'color', laneCls: 'span', titleKey: 'editorScrollMarkers.jumpToComment' });
function fixture() {
  const root = Object.assign(new Target(), { scrollTop: 0, scrollHeight: 1400,
    children: [new Target()], getBoundingClientRect: vi.fn(() => ({ top: 100 })),
    querySelector: vi.fn((selector: string) => anchors.get(selector) ?? null) });
  const anchor = (top: number) => ({ top,
    getBoundingClientRect: vi.fn(function(this: {top: number}) { return { top: 100 + this.top - root.scrollTop }; }) });
  const a = anchor(100); const b = anchor(700);
  const anchors = new Map<string, ReturnType<typeof anchor>>([['[data-block-id="a"]', a], ['[data-block-id="b"]', b]]);
  const owner = new ScrollMarkerViewportController(root as unknown as HTMLElement);
  owner.configure([marker('c', ['a'])]);
  const dispose = owner.attach();
  return { root, owner, dispose, a, b, anchors,
    show: (needed: boolean) => owner.setPresentationNeeded(needed),
    configure: (markers: ScrollMarker[]) => owner.configure(markers),
    reads: () => a.getBoundingClientRect.mock.calls.length + b.getBoundingClientRect.mock.calls.length };
}
beforeEach(() => {
  frames.clear(); sequence = 0; Resize.all = []; Mutation.all = [];
  vi.stubGlobal('window', new Target());
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', Resize); vi.stubGlobal('MutationObserver', Mutation);
});
afterEach(() => vi.unstubAllGlobals());

describe('visible nonempty review marker viewport', () => {
  it('measures a shared anchor once, stops after first present range block and skips orphans', () => {
    const f = fixture();
    f.configure([marker('range', ['missing', 'a', 'b']), marker('agent', ['a']), marker('deleted-first', []), marker('orphan', ['absent'])]);
    f.show(true);
    expect(f.owner.getSnapshot().map(t => [t.key, t.frac])).toEqual([['deleted-first', 0], ['range', 100 / 1400], ['agent', 100 / 1400]]);
    expect(f.a.getBoundingClientRect).toHaveBeenCalledOnce(); expect(f.b.getBoundingClientRect).not.toHaveBeenCalled();
    expect(f.root.querySelector.mock.calls.filter(([s]) => s === '[data-block-id="a"]')).toHaveLength(1);
    f.dispose();
  });

  it('coalesces layout invalidations, retains content-relative fractions and ignores ordinary scroll', () => {
    const f = fixture(); f.show(true); const snapshot = f.owner.getSnapshot(); const reads = f.reads();
    const notify = vi.fn(); const off = f.owner.subscribe(notify);
    f.root.scrollTop = 240; f.root.dispatchEvent(new Event('scroll'));
    expect(frames.size).toBe(0); expect(f.reads()).toBe(reads);
    for (let i = 0; i < 20; i++) { Resize.all[0].callback(); Mutation.all[0].callback(); window.dispatchEvent(new Event('resize')); }
    expect(frames.size).toBe(1); paint(); expect(f.reads()).toBe(reads + 1);
    expect(f.owner.getSnapshot()).toBe(snapshot); expect(notify).not.toHaveBeenCalled();
    off(); f.dispose();
  });

  it('publishes new click ranges, lanes and titles when position remains identical', () => {
    const f = fixture(); f.show(true);
    f.configure([{ ...marker('c', ['a', 'b']), laneCls: 'lane2', titleKey: 'editorScrollMarkers.jumpToTodo' }]); f.show(true);
    expect(f.owner.getSnapshot()[0]).toMatchObject({ blockIds: ['a', 'b'], frac: 100 / 1400, laneCls: 'lane2', titleKey: 'editorScrollMarkers.jumpToTodo' });
    f.dispose();
  });

  it('pauses hidden work and prepares replacement anchors synchronously on return', () => {
    const f = fixture(); f.show(true); Resize.all[0].callback(); f.show(false);
    const before = f.owner.getSnapshot(); const reads = f.reads();
    f.configure([marker('c', ['b'])]); f.b.top = 1100; f.root.scrollHeight = 2200;
    Resize.all[0].callback(); Mutation.all[0].callback(); f.root.dispatchEvent(new Event('load')); paint();
    expect(f.reads()).toBe(reads); expect(frames.size).toBe(0); expect(f.owner.getSnapshot()).toBe(before);
    f.show(true); expect(f.owner.getSnapshot()[0]).toMatchObject({ blockIds: ['b'], frac: 0.5 });
    expect(frames.size).toBe(0); f.dispose();
  });

  it('releases empty viewports, observes newly present anchors and releases removed nodes', () => {
    const f = fixture(); f.configure([]); f.show(true);
    expect(Resize.all).toHaveLength(0); expect(f.root.getBoundingClientRect).not.toHaveBeenCalled();
    f.configure([marker('c', ['missing', 'b'])]); f.show(true); const resize = Resize.all[0];
    expect(resize.targets.has(f.b as unknown as Element)).toBe(true);
    f.anchors.set('[data-block-id="missing"]', f.a); Mutation.all[0].callback(); paint();
    expect(f.owner.getSnapshot()[0].frac).toBe(100 / 1400);
    expect(resize.targets.has(f.b as unknown as Element)).toBe(false);
    f.configure([]); f.show(true);
    expect(f.owner.getSnapshot()).toEqual([]); expect(resize.targets.size).toBe(0);
    expect(Mutation.all.every(o => !o.active)).toBe(true); expect(f.root.listeners.size).toBe(0); f.dispose();
  });

  it.each([1, 5, 20])('keeps only visible marker work for %i retained viewports', count => {
    const all = Array.from({ length: count }, fixture);
    all.forEach(f => { f.show(true); f.show(false); }); all[0].show(true);
    const hidden = all.slice(1).map(f => f.reads());
    for (let i = 0; i < 20; i++) { Resize.all.forEach(o => o.callback()); Mutation.all.forEach(o => o.callback()); }
    expect(frames.size).toBe(1); paint(); expect(all.slice(1).map(f => f.reads())).toEqual(hidden);
    expect(Resize.all.filter(o => o.targets.size)).toHaveLength(1);
    all.forEach(f => f.dispose());
    expect(Resize.all.every(o => o.targets.size === 0)).toBe(true); expect(Mutation.all.every(o => !o.active)).toBe(true);
    expect(all.every(f => f.root.listeners.size === 0)).toBe(true); expect((window as unknown as Target).listeners.size).toBe(0); expect(frames.size).toBe(0);
  });

  it('tracks virtual tail changes but ignores descendant animation styles', () => {
    const f = fixture(); f.show(true); const reads = f.reads();
    Mutation.all[0].callback([{ type: 'attributes', attributeName: 'style', target: f.a } as unknown as MutationRecord]);
    expect(frames.size).toBe(0);
    f.root.scrollHeight = 2800;
    Mutation.all[0].callback([{ type: 'attributes', attributeName: 'style', target: f.root } as unknown as MutationRecord]);
    paint(); expect(f.reads()).toBe(reads + 1); expect(f.owner.getSnapshot()[0].frac).toBe(100 / 2800); f.dispose();
  });

  it('can replay effect attachment and does not publish after disposal', () => {
    const f = fixture(); f.show(true); f.dispose(); const before = f.reads();
    Resize.all[0].callback(); paint(); expect(f.reads()).toBe(before);
    const dispose = f.owner.attach(); expect(f.reads()).toBe(before + 1);
    dispose(); expect(frames.size).toBe(0); expect(f.root.listeners.size).toBe(0);
  });
});
