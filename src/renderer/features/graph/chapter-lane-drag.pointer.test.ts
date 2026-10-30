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

  it('keeps a weighted slab in its lane until the pointer passes the next lane middle', async () => {
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
      style: { visibility: '' } as CSSStyleDeclaration,
      cloneNode: () => ghost,
      getBoundingClientRect: () => ({ left: 80, top: 80, width: 120, height: 40 }) as DOMRect,
    } as unknown as HTMLElement;
    const rows = [80, 120, 160].map((top) => ({ top, bottom: top + 40, height: 40 }) as DOMRect);
    const lanes = ['lane-a', 'lane-b', 'lane-c'];
    const resolveTarget = vi.fn((_x: number, y: number): ChapterLanePointerTarget | null => {
      const lane = rows.findIndex((row) => y >= row.top && y < row.bottom);
      return lane < 0 ? null : { storylineId: lanes[lane], order: 1 };
    });
    const onDrop = vi.fn(async () => undefined);
    startChapterLanePointerDrag({
      pointerId: 1,
      pointerType: 'mouse',
      startClientX: 100,
      startClientY: 100,
      sourceElement: source,
      grabOffsetX: 20,
      resolveTarget,
      onDragStart: vi.fn(),
      onDrop,
      onDragEnd: vi.fn(),
      weighted: { rows: () => rows },
    });

    // Into the next lane but short of its middle: the slab stays where it was.
    pointer('pointermove', { pointerType: 'mouse', clientX: 140, clientY: 135 });
    frame?.(16);
    expect(resolveTarget).toHaveBeenLastCalledWith(140, 100);
    // Past the middle: one snap over; the drop lands on the lane the slab is in.
    pointer('pointermove', { pointerType: 'mouse', clientX: 150, clientY: 145 });
    frame?.(32);
    expect(resolveTarget).toHaveBeenLastCalledWith(150, 140);
    pointer('pointerup', { pointerType: 'mouse', clientX: 150, clientY: 145 });
    await flushPromises();
    expect(onDrop).toHaveBeenCalledWith({ storylineId: 'lane-b', order: 1 });
    // The ghost follows on a spring: it has not jumped onto the pointer.
    expect(ghostStyle.transform).not.toBe('translate3d(130px, 105px, 0)');
  });

  it('wears the colour of the lane it is over, once per lane, and leaves the source alone', () => {
    const colors: Record<string, string> = { 'lane-a': '#aa3322', 'lane-b': '#2266aa', 'lane-c': '#669933' };
    const worn = new Map<string, string>();
    const ghostStyle = {
      setProperty: vi.fn((name: string, value: string) => worn.set(name, value)),
    } as unknown as CSSStyleDeclaration;
    const ghost = {
      style: ghostStyle,
      removeAttribute: vi.fn(),
      setAttribute: vi.fn(),
      classList: { add: vi.fn() },
      remove: () => {
        ghostRemoved = true;
      },
    } as unknown as HTMLElement;
    const sourceSet = vi.fn();
    const source = {
      style: {
        visibility: '',
        // The source's own inline colour: its lane's (lane-a).
        getPropertyValue: (name: string) => (name === '--glass-cc' || name === '--clip-color' ? colors['lane-a'] : ''),
        setProperty: sourceSet,
      } as unknown as CSSStyleDeclaration,
      cloneNode: () => ghost,
      getBoundingClientRect: () => ({ left: 80, top: 80, width: 120, height: 40 }) as DOMRect,
    } as unknown as HTMLElement;
    const rows = [80, 120, 160].map((top) => ({ top, bottom: top + 40, height: 40 }) as DOMRect);
    const lanes = ['lane-a', 'lane-b', 'lane-c'];
    const laneColor = vi.fn((lane: string) => colors[lane]);
    startChapterLanePointerDrag({
      pointerId: 1,
      pointerType: 'mouse',
      startClientX: 100,
      startClientY: 100,
      sourceElement: source,
      grabOffsetX: 20,
      resolveTarget: (_x, y) => {
        const lane = rows.findIndex((row) => y >= row.top && y < row.bottom);
        return lane < 0 ? null : { storylineId: lanes[lane], order: 1 };
      },
      onDragStart: vi.fn(),
      onDrop: vi.fn(async () => undefined),
      onDragEnd: vi.fn(),
      weighted: { rows: () => rows },
      laneColor,
    });
    const move = (clientX: number, clientY: number) => {
      pointer('pointermove', { pointerType: 'mouse', clientX, clientY });
      frame?.(16);
    };

    // Still in its own lane: its own colour.
    move(140, 135);
    expect(worn.get('--glass-cc')).toBe(colors['lane-a']);
    // Over the next lane (past its middle): that lane's colour, glass and clip alike.
    move(150, 145);
    expect(worn.get('--glass-cc')).toBe(colors['lane-b']);
    expect(worn.get('--clip-color')).toBe(colors['lane-b']);
    const writes = vi.mocked(ghostStyle.setProperty).mock.calls.length;
    // Moving within that lane writes nothing more.
    move(170, 150);
    move(190, 152);
    expect(vi.mocked(ghostStyle.setProperty).mock.calls.length).toBe(writes);
    expect(laneColor).toHaveBeenCalledTimes(2);
    // Carried clear of every lane: no drop, so its own colour again.
    move(150, 30);
    expect(worn.get('--glass-cc')).toBe(colors['lane-a']);
    // Cancelled: the ghost goes and the source was never repainted.
    pointer('pointercancel', { pointerType: 'mouse', clientX: 150, clientY: 30 });
    expect(ghostRemoved).toBe(true);
    expect(sourceSet).not.toHaveBeenCalled();
  });
});
