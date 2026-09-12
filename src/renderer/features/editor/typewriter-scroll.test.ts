import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TypewriterScrollController } from './typewriter-scroll';

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { TestResizeObserver.instances.push(this); }
  observe(target: Element) { this.observed.add(target); }
  disconnect() { this.observed.clear(); }
  fire() { this.callback([], this as unknown as ResizeObserver); }
}
function paint() {
  const pending = [...frames.entries()]; frames.clear();
  for (const [, callback] of pending) callback(0);
}
function fixture() {
  const properties = new Map<string, string>();
  const attributes = new Map<string, string>();
  const caretAttributes = new Map<string, string>();
  const reads = { height: 0 };
  let height = 800;
  const viewport = {
    scrollTop: 300, scrollHeight: 2400,
    get clientHeight() { reads.height++; return height; },
    getBoundingClientRect: vi.fn(() => ({ top: 100 })),
    style: { getPropertyValue: (key: string) => properties.get(key) ?? '',
      setProperty: vi.fn((key: string, value: string) => properties.set(key, value)),
      removeProperty: (key: string) => properties.delete(key) },
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  };
  const callbacks = new Map<string, Set<() => void>>();
  const editor = {
    isDestroyed: false, isFocused: true, state: { selection: { empty: true, head: 1 } },
    view: { dom: { closest: () => viewport,
      setAttribute: (key: string, value: string) => caretAttributes.set(key, value),
      removeAttribute: (key: string) => caretAttributes.delete(key) },
    coordsAtPos: vi.fn(() => ({ top: 590, bottom: 610 })) },
    on(name: string, fn: () => void) { const listeners = callbacks.get(name) ?? new Set(); listeners.add(fn); callbacks.set(name, listeners); },
    off(name: string, fn: () => void) { callbacks.get(name)?.delete(fn); },
  };
  const controller = new TypewriterScrollController(editor as unknown as Editor);
  const dispose = controller.attach();
  return { controller, editor, dispose, properties, attributes, caretAttributes, viewport, reads,
    height(value: number) { height = value; },
    listeners: () => [...callbacks.values()].reduce((sum, listeners) => sum + listeners.size, 0),
    emit(event: string) { for (const fn of [...callbacks.get(event) ?? []]) fn(); },
    present(isVisible: boolean, isPreparing = false, position = 50) { controller.setPresentation({ isVisible, isPreparing }, position); },
  };
}

beforeEach(() => {
  frames.clear(); nextFrame = 0; TestResizeObserver.instances = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++nextFrame, cb); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

describe('visibility-owned typewriter work', () => {
  it('prepares tail geometry without moving an incoming hidden caret', () => {
    const f = fixture();
    f.present(false, true);
    expect(f.properties.get('--editor-typewriter-tail-space')).toBe('424px');
    expect(f.viewport.scrollTop).toBe(300);
    expect(frames.size).toBe(0);
    f.present(true); f.emit('update'); f.emit('selectionUpdate');
    expect(frames.size).toBe(1);
    paint();
    expect(f.editor.view.coordsAtPos).toHaveBeenCalledOnce();
    expect(f.viewport.scrollTop).toBe(400);
    expect(f.caretAttributes.get('data-typewriter-caret-repaint')).toBe('on');
    paint(); expect(f.caretAttributes.size).toBe(0);
    f.dispose(); expect(f.listeners()).toBe(0);
  });

  it('cancels frames and observers on hide while retaining tail and scroll position', () => {
    const f = fixture(); f.present(true);
    const observer = TestResizeObserver.instances[0];
    f.present(false);
    const before = f.reads.height;
    observer.fire(); f.emit('update'); f.emit('focus'); f.emit('selectionUpdate'); paint();
    expect(f.reads.height).toBe(before);
    expect(f.editor.view.coordsAtPos).not.toHaveBeenCalled();
    expect(f.listeners()).toBe(1); // Only final destruction, no display listeners.
    expect(observer.observed.size).toBe(0);
    expect(frames.size).toBe(0);
    expect(f.viewport.scrollTop).toBe(300);
    expect(f.attributes.get('data-typewriter-scroll')).toBe('on');
    expect(f.properties.get('--editor-typewriter-tail-space')).toBe('424px');
    f.dispose(); expect(f.properties.size).toBe(0); expect(f.attributes.size).toBe(0);
  });

  it('defers hidden resizes and position changes, preparing the latest size synchronously', () => {
    const f = fixture(); f.present(true); f.present(false);
    const reads = f.reads.height;
    f.height(1000); f.present(false, false, 25);
    expect(f.reads.height).toBe(reads);
    expect(f.properties.get('--editor-typewriter-tail-space')).toBe('424px');
    f.present(false, true, 25);
    expect(f.properties.get('--editor-typewriter-tail-space')).toBe('774px');
    expect(frames.size).toBe(0);
    f.dispose();
  });

  it('keeps both visible split viewports prepared but aligns only the focused editor', () => {
    const left = fixture(); const right = fixture(); right.editor.isFocused = false;
    left.present(true); right.present(true);
    expect(TestResizeObserver.instances.filter(o => o.observed.size).length).toBe(2);
    paint();
    expect(left.editor.view.coordsAtPos).toHaveBeenCalledOnce();
    expect(right.editor.view.coordsAtPos).not.toHaveBeenCalled();
    right.editor.isFocused = true; left.editor.isFocused = false;
    right.emit('focus'); paint();
    expect(right.editor.view.coordsAtPos).toHaveBeenCalledOnce();
    left.dispose(); right.dispose(); expect(frames.size).toBe(0);
  });

  it.each([1, 5, 20])('keeps %i retained editors free of hidden display work and releases every owner', count => {
    const editors = Array.from({ length: count }, fixture);
    editors.forEach(f => { f.present(true); f.present(false); });
    editors[0].present(true);
    paint(); paint();
    const hiddenReads = editors.slice(1).map(f => f.reads.height);
    for (let event = 0; event < 10; event++) {
      editors.forEach(f => { f.emit('update'); f.emit('selectionUpdate'); });
      TestResizeObserver.instances.forEach(observer => observer.fire());
    }
    expect(frames.size).toBe(1);
    expect(editors.slice(1).map(f => f.reads.height)).toEqual(hiddenReads);
    expect(TestResizeObserver.instances.filter(o => o.observed.size).length).toBe(1);
    expect(editors.reduce((sum, f) => sum + f.listeners(), 0)).toBe(count + 3);
    editors.forEach(f => f.dispose());
    expect(TestResizeObserver.instances.every(o => o.observed.size === 0)).toBe(true);
    expect(editors.reduce((sum, f) => sum + f.listeners(), 0)).toBe(0);
    expect(frames.size).toBe(0);
  });

  it('restores a suppressed caret on hide and supports effect replay and destruction', () => {
    const f = fixture(); f.present(true); paint();
    expect(f.caretAttributes.size).toBe(1);
    f.present(false); expect(f.caretAttributes.size).toBe(0);
    f.dispose(); const dispose = f.controller.attach(); f.present(true);
    expect(f.listeners()).toBe(4);
    f.emit('destroy'); f.editor.isDestroyed = true; dispose();
    expect(f.listeners()).toBe(0); expect(frames.size).toBe(0);
    expect(f.properties.size).toBe(0);
  });

  it('does not schedule geometry for an unfocused editor or a noncollapsed selection', () => {
    const f = fixture(); f.editor.isFocused = false; f.present(true);
    f.emit('update'); expect(frames.size).toBe(0);
    f.editor.isFocused = true; f.editor.state.selection.empty = false;
    f.emit('selectionUpdate'); expect(frames.size).toBe(0);
    f.dispose();
  });
});
