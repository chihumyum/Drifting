import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStoryGraphWheelPan,
  isStoryGraphPanBlockedTarget,
  startStoryGraphPointerPan,
} from './story-graph-scroll-pan';

function dispatchWindowEvent(
  type: string,
  init: { pointerId?: number; clientX?: number; clientY?: number } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
  });
  window.dispatchEvent(event);
  return event;
}

function fakeTarget(matchedTokens: string[]): EventTarget {
  return {
    closest: (selector: string) => {
      const parts = selector.split(',').map((part) => part.trim());
      return parts.some((part) => matchedTokens.includes(part)) ? ({} as Element) : null;
    },
  } as unknown as EventTarget;
}

describe('story graph scroll pan', () => {
  beforeEach(() => {
    const fakeWindow = new EventTarget() as EventTarget & typeof globalThis;
    Object.assign(fakeWindow, {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      getSelection: () => ({ removeAllRanges: vi.fn() }),
    });
    vi.stubGlobal('window', fakeWindow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('left-drags empty track space past 3px, updates scroll, and eats trailing click', () => {
    const classes = new Set<string>();
    const container = {
      scrollLeft: 200,
      scrollTop: 100,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    } as unknown as HTMLElement;
    const blankTrack = fakeTarget(['.graph-track-cell']);
    const onPanStart = vi.fn();

    const handle = startStoryGraphPointerPan({
      container,
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      startClientX: 300,
      startClientY: 250,
      target: blankTrack,
      onPanStart,
    });
    expect(handle.started).toBe(true);

    // Sub-threshold jitter leaves click / double-click untouched.
    dispatchWindowEvent('pointermove', { pointerId: 7, clientX: 299, clientY: 249 });
    expect(onPanStart).not.toHaveBeenCalled();
    expect(classes.has('is-panning')).toBe(false);

    dispatchWindowEvent('pointermove', { pointerId: 7, clientX: 240, clientY: 210 });
    expect(onPanStart).toHaveBeenCalledTimes(1);
    expect(classes.has('is-panning')).toBe(true);
    expect(container.scrollLeft).toBe(260);
    expect(container.scrollTop).toBe(140);

    dispatchWindowEvent('pointerup', { pointerId: 7, clientX: 240, clientY: 210 });
    expect(classes.has('is-panning')).toBe(false);

    const trailingClick = dispatchWindowEvent('click');
    expect(trailingClick.defaultPrevented).toBe(true);
  });

  it('ignores left-button presses on tiles, pins, act labels, edges, and buttons, while allowing middle-button pan', () => {
    for (const token of [
      '.graph-tile',
      '.graph-pin',
      '.actrail__label',
      '.actrail__divider',
      '.graph-edge-grp',
      'button',
      'input',
    ]) {
      expect(isStoryGraphPanBlockedTarget(fakeTarget([token]), 0), token).toBe(true);
    }
    expect(isStoryGraphPanBlockedTarget(fakeTarget(['.graph-track-cell']), 0)).toBe(false);

    // Middle mouse pans over tiles, but still leaves text inputs alone.
    expect(isStoryGraphPanBlockedTarget(fakeTarget(['.graph-tile']), 1)).toBe(false);
    expect(isStoryGraphPanBlockedTarget(fakeTarget(['input']), 1)).toBe(true);
  });

  it('maps plain vertical mouse wheel to horizontal scroll only when vertical overflow is absent', () => {
    const container = {
      scrollLeft: 100,
      scrollWidth: 1800,
      clientWidth: 900,
      scrollHeight: 500,
      clientHeight: 500,
    } as unknown as HTMLElement;

    const preventDefault = vi.fn();
    expect(applyStoryGraphWheelPan(container, { deltaX: 0, deltaY: 120, preventDefault })).toBe(
      true,
    );
    expect(container.scrollLeft).toBe(220);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // When storylines overflow vertically, native vertical wheel scrolling wins.
    Object.assign(container, { scrollHeight: 900 });
    expect(applyStoryGraphWheelPan(container, { deltaX: 0, deltaY: 120 })).toBe(false);
    expect(container.scrollLeft).toBe(220);
  });
});
