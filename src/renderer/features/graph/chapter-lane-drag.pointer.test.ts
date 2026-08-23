import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startChapterLanePointerDrag,
  type ChapterLanePointerTarget,
} from './chapter-lane-drag';
import { MOBILE_PLANNING_DRAG_ARM_MS } from './mobile-planning-gesture';

function pointer(
  type: string,
  input: { pointerId?: number; pointerType?: string; clientX?: number; clientY?: number } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: input.pointerId ?? 1 },
    pointerType: { value: input.pointerType ?? 'touch' },
    clientX: { value: input.clientX ?? 100 },
    clientY: { value: input.clientY ?? 100 },
  });
  window.dispatchEvent(event);
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('chapter lane pointer lifecycle', () => {
  let frame: FrameRequestCallback | null;
  let ghostRemoved: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    frame = null;
    ghostRemoved = true;
    const fakeWindow = new EventTarget() as EventTarget & typeof globalThis;
    Object.assign(fakeWindow, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      },
      cancelAnimationFrame: () => {
        frame = null;
      },
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    const classes = new Set<string>();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      body: {
        appendChild: () => {
          ghostRemoved = false;
        },
      },
      documentElement: {
        classList: {
          add: (value: string) => classes.add(value),
          remove: (value: string) => classes.delete(value),
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const setup = (
    resolve: () => ChapterLanePointerTarget | null = () => ({
      storylineId: 'lane-b',
      order: 12.5,
    }),
  ) => {
    const sourceStyle = { visibility: '' } as CSSStyleDeclaration;
    const ghostStyle = {} as CSSStyleDeclaration;
    const ghost = {
      style: ghostStyle,
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
      classList: { add: vi.fn() },
      remove: () => {
        ghostRemoved = true;
      },
    } as unknown as HTMLElement;
    const source = {
      style: sourceStyle,
      cloneNode: () => ghost,
      getBoundingClientRect: () =>
        ({ left: 80, top: 80, width: 120, height: 44 }) as DOMRect,
    } as unknown as HTMLElement;
    const onDragStart = vi.fn();
    const onDrop = vi.fn(async () => undefined);
    const onDragEnd = vi.fn();
    const onMenu = vi.fn();
    const handle = startChapterLanePointerDrag({
      pointerId: 1,
      pointerType: 'touch',
      startClientX: 100,
      startClientY: 100,
      sourceElement: source,
      grabOffsetX: 20,
      resolveTarget: resolve,
      onDragStart,
      onDrop,
      onDragEnd,
      mobileTouch: { onMenu, scrollContainer: null },
    });
    return { source, onDragStart, onDrop, onDragEnd, onMenu, handle };
  };

  it('arms before movement and commits one valid drop exactly once', async () => {
    const state = setup();
    vi.advanceTimersByTime(MOBILE_PLANNING_DRAG_ARM_MS);
    pointer('pointermove', { clientX: 120 });
    frame?.(0);
    pointer('pointerup', { clientX: 120 });
    pointer('pointerup', { clientX: 140 });
    await flushPromises();

    expect(state.onDragStart).toHaveBeenCalledTimes(1);
    expect(state.onDrop).toHaveBeenCalledTimes(1);
    expect(state.onDrop).toHaveBeenCalledWith({ storylineId: 'lane-b', order: 12.5 });
    expect(state.onDragEnd).toHaveBeenCalledTimes(1);
    expect(state.source.style.visibility).toBe('');
    expect(ghostRemoved).toBe(true);
  });

  it('performs zero writes for early pan, invalid target, cancel, pinch, and explicit cancel', async () => {
    const earlyPan = setup();
    pointer('pointermove', { clientX: 120 });
    pointer('pointerup', { clientX: 120 });

    const invalid = setup(() => null);
    vi.advanceTimersByTime(MOBILE_PLANNING_DRAG_ARM_MS);
    pointer('pointermove', { clientX: 120 });
    frame?.(0);
    pointer('pointerup', { clientX: 120 });
    await flushPromises();

    const cancelled = setup();
    vi.advanceTimersByTime(MOBILE_PLANNING_DRAG_ARM_MS);
    pointer('pointermove', { clientX: 120 });
    frame?.(0);
    pointer('pointercancel', { clientX: 120 });

    const pinched = setup();
    pointer('pointerdown', { pointerId: 2, clientX: 130 });

    const explicit = setup();
    explicit.handle.cancel();
    await flushPromises();

    for (const state of [earlyPan, invalid, cancelled, pinched, explicit]) {
      expect(state.onDrop).not.toHaveBeenCalled();
      expect(state.source.style.visibility).toBe('');
    }
    expect(ghostRemoved).toBe(true);
  });

  it('opens the shared menu after a stationary hold without starting or writing', () => {
    const state = setup();
    vi.advanceTimersByTime(500);

    expect(state.onMenu).toHaveBeenCalledTimes(1);
    expect(state.onDragStart).not.toHaveBeenCalled();
    expect(state.onDrop).not.toHaveBeenCalled();
  });
});
