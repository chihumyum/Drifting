import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutlineViewportController } from './outline-viewport';
import { flattenOutlineEntries, type OutlineEntry } from './outline-rail-model';

const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
class Target extends EventTarget {
  listeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(name: string, fn: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) { if (fn) this.listeners.add(fn); super.addEventListener(name, fn, options); }
  override removeEventListener(name: string, fn: EventListenerOrEventListenerObject | null) { if (fn) this.listeners.delete(fn); super.removeEventListener(name, fn); }
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
  constructor(readonly callback: () => void) { Mutation.all.push(this); }
  observe() { this.active = true; }
  disconnect() { this.active = false; }
}
function paint() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); }
const entries: OutlineEntry[] = [
  { id: 'a', kind: 'heading', level: 1, text: 'Scene A' },
  { id: 'b', kind: 'heading', level: 2, text: 'Beat B' },
];
function fixture() {
  const root = Object.assign(new Target(), { scrollTop: 0, clientHeight: 400, scrollHeight: 1400,
    children: [new Target()], getBoundingClientRect: vi.fn(() => ({ top: 100 })),
    querySelector: vi.fn((selector: string) => anchors.get(selector) ?? null) });
  const anchor = (top: number, height = 30) => ({ top, height,
    getBoundingClientRect: vi.fn(function(this: {top: number; height: number}) { return { top: 100 + this.top - root.scrollTop, bottom: 100 + this.top + this.height - root.scrollTop }; }) });
  const a = anchor(0); const b = anchor(300);
  const anchors = new Map<string, ReturnType<typeof anchor>>([['[data-block-id="a"]', a], ['[data-block-id="b"]', b]]);
  const rail = { clientHeight: 500 }; const body = new Target();
  const owner = new OutlineViewportController(root as unknown as HTMLElement, rail as HTMLElement, body as unknown as HTMLElement);
  owner.configure(flattenOutlineEntries(entries), ['a', 'b']);
  const dispose = owner.attach();
  return { root, rail, body, owner, dispose, a, b, anchors,
    configure(items = entries, ids = ['a', 'b']) { owner.configure(flattenOutlineEntries(items), ids); },
    show(needed: boolean) { owner.setPresentationNeeded(needed); },
    scroll(top: number) { root.scrollTop = top; root.dispatchEvent(new Event('scroll')); },
    reads: () => a.getBoundingClientRect.mock.calls.length + b.getBoundingClientRect.mock.calls.length,
  };
}
beforeEach(() => {
  frames.clear(); sequence = 0; Resize.all = []; Mutation.all = [];
  vi.stubGlobal('window', new Target());
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', Resize); vi.stubGlobal('MutationObserver', Mutation);
});
afterEach(() => vi.unstubAllGlobals());

describe('one outline viewport owns geometry and reading location', () => {
  it('prepares scoped geometry and coalesces scroll without reading anchors again', () => {
    const f = fixture(); f.show(true);
    expect(f.owner.getSnapshot()).toMatchObject({ primaryId: 'a', railHeight: 500, geometry: { offsets: { a: 0, b: 300 } } });
    const reads = f.reads(); const queries = f.root.querySelector.mock.calls.length;
    for (let i = 0; i < 20; i++) f.scroll(220 + i);
    expect(frames.size).toBe(1); paint();
    expect(f.reads()).toBe(reads); expect(f.root.querySelector.mock.calls.length).toBe(queries);
    expect(f.owner.getSnapshot()).toMatchObject({ primaryId: 'b', geometry: { scrollTop: 239 } });
    f.dispose();
  });

  it('shares an anchor DOM read across aliases and preserves framework selectors', () => {
    const f = fixture();
    f.anchors.set('[data-act-id="act"]', f.a); f.anchors.set('[data-chapter-id="chapter"]', f.b);
    f.anchors.set('#section', f.b);
    f.configure([{id: 'act:act', kind: 'act', level: 1, text: 'Act'}, {id:'chapter',kind:'chapter',level:2,text:'Chapter'}, {id:'section',kind:'section',level:2,text:'Section'}, ...entries]);
    f.show(true);
    expect(f.a.getBoundingClientRect).toHaveBeenCalledOnce(); expect(f.b.getBoundingClientRect).toHaveBeenCalledOnce();
    expect(f.owner.getSnapshot().geometry.offsets).toEqual({ 'act:act': 0, chapter: 300, section: 300, a: 0, b: 300 });
    f.dispose();
  });

  it('does not publish unchanged geometry, and labels alone do not invalidate layout', () => {
    const f = fixture(); f.show(true);
    const notify = vi.fn(); const off = f.owner.subscribe(notify); const before = f.owner.getSnapshot();
    Resize.all[0].callback(); Mutation.all[0].callback(); paint();
    expect(f.owner.getSnapshot()).toBe(before); expect(notify).not.toHaveBeenCalled();
    const reads = f.reads(); f.configure(entries.map(e => ({...e, text: 'New label'}))); f.show(true);
    expect(f.reads()).toBe(reads);
    off(); f.dispose();
  });

  it('pins a clicked heading while visible, then resumes the same threshold scan', () => {
    const f = fixture(); f.show(true); f.owner.pin('b');
    f.scroll(0); paint(); expect(f.owner.getSnapshot().primaryId).toBe('b');
    f.scroll(340); paint(); expect(f.owner.getSnapshot().primaryId).toBe('b');
    f.scroll(0); paint(); expect(f.owner.getSnapshot().primaryId).toBe('a');
    f.owner.pin('b'); f.configure(entries.slice(0,1), ['a']); f.show(true);
    expect(f.owner.getSnapshot().primaryId).toBe('a'); f.dispose();
  });

  it('defers hidden mutation/resize/reading changes and prepares the current DOM synchronously', () => {
    const f = fixture(); f.show(true); f.owner.pin('b'); f.scroll(40); f.show(false);
    const before = f.owner.getSnapshot(); const reads = f.reads();
    f.b.top = 600; f.root.clientHeight = 350; f.rail.clientHeight = 450;
    Resize.all[0].callback(); Mutation.all[0].callback(); f.scroll(520); paint();
    expect(f.reads()).toBe(reads); expect(f.owner.getSnapshot()).toBe(before); expect(frames.size).toBe(0);
    f.show(true);
    expect(f.owner.getSnapshot()).toMatchObject({ primaryId: 'b', railHeight: 450, geometry: { offsets: { b: 600 }, scrollTop: 520, clientHeight: 350 } });
    expect(frames.size).toBe(0); f.dispose();
  });

  it('unobserves removed direct children and disconnects all targets on disposal', () => {
    const f = fixture(); f.show(true); const observer = Resize.all[0];
    const removed = f.root.children[0]; const replacement = new Target();
    f.root.children = [replacement]; Mutation.all[0].callback();
    expect(observer.targets.has(removed as unknown as Element)).toBe(false); expect(observer.targets.has(replacement as unknown as Element)).toBe(true);
    f.dispose(); expect(observer.targets.size).toBe(0); expect(frames.size).toBe(0);
  });

  it.each([1, 5, 20])('keeps hidden display work at zero for %i retained viewports and releases every listener', count => {
    const all = Array.from({ length: count }, fixture);
    all.forEach(f => { f.show(true); f.show(false); }); all[0].show(true);
    const hidden = all.slice(1).map(f => f.reads());
    for (let repeat = 0; repeat < 20; repeat++) {
      all.forEach(f => f.scroll(200 + repeat));
      Resize.all.forEach(o => o.callback()); Mutation.all.forEach(o => o.callback());
    }
    expect(frames.size).toBe(1); paint();
    expect(all.slice(1).map(f => f.reads())).toEqual(hidden);
    expect(Resize.all.filter(o => o.targets.size).length).toBe(1);
    expect(Mutation.all.filter(o => o.active).length).toBe(1);
    expect(all.reduce((sum,f) => sum+f.root.listeners.size,0)).toBe(1);
    all.forEach(f => f.dispose());
    expect((window as unknown as Target).listeners.size).toBe(0);
    expect(all.every(f => f.root.listeners.size===0)).toBe(true);
    expect(Resize.all.every(o => o.targets.size===0)).toBe(true); expect(frames.size).toBe(0);
  });

  it('remeasures when scroll dimensions change and can reattach after effect cleanup', () => {
    const f = fixture(); f.show(true); const firstReads = f.reads();
    f.root.scrollHeight = 2800; f.scroll(30); paint();
    expect(f.reads()).toBe(firstReads+2);
    expect(f.owner.getSnapshot().geometry.fractions.b).toBe(300/2800);
    f.dispose(); const dispose = f.owner.attach();
    expect(f.root.listeners.size).toBe(1); dispose(); expect(f.root.listeners.size).toBe(0);
  });
});
