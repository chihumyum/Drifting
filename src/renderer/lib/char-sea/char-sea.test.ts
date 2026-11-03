import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCharSea } from './char-sea';

/** A WebGL2 context that accepts everything and draws nothing. */
function fakeWebGL(): WebGL2RenderingContext {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      if (name === 'getShaderParameter' || name === 'getProgramParameter') return () => true;
      return () => ({});
    },
  }) as WebGL2RenderingContext;
}

/**
 * A window of 960 × 600 whose frames come at `hz` a second, driven by hand:
 * `run(seconds)` plays that many seconds of frames and says how long it ran
 * before the loop stopped asking for one.
 */
function windowAt(hz: number) {
  let frames: FrameRequestCallback[] = [];
  let now = 1000;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
  vi.stubGlobal('window', { innerWidth: 960, innerHeight: 600, devicePixelRatio: 1, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    documentElement: { dataset: {}, classList: { contains: () => false } },
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; src = ''; });
  const gl = fakeWebGL();
  const canvas = { clientWidth: 960, clientHeight: 600, width: 0, height: 0, getContext: () => gl };
  const sea = createCharSea(canvas as unknown as HTMLCanvasElement)!;
  const run = (seconds: number) => {
    const start = now;
    while (now - start < seconds * 1000) {
      const due = frames;
      frames = [];
      if (!due.length) break;
      now += 1000 / hz;
      for (const callback of due) callback(now);
    }
    return (now - start) / 1000;
  };
  return { sea, run };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the sea of characters on a display of any refresh rate', () => {
  it.each([60, 120, 144])('goes still after a press and calls an ebb back (%iHz)', (hz) => {
    const { sea, run } = windowAt(hz);
    sea.setActive(true);
    sea.drop(480, 300);
    expect(run(1)).toBeCloseTo(1, 1);
    const onStill = vi.fn();
    sea.ebb(onStill);
    // A press is still water in about five seconds; the ebb calls back then, well before the 8s fallback.
    const ran = run(10);
    expect(onStill).toHaveBeenCalledTimes(1);
    expect(1 + ran).toBeGreaterThan(3.5);
    expect(1 + ran).toBeLessThan(6.5);
  });

  it.each([60, 120, 144])('stops on its own when nothing touches it (%iHz)', (hz) => {
    const { sea, run } = windowAt(hz);
    sea.setActive(true);
    sea.drop(480, 300);
    expect(run(10)).toBeLessThan(6.5);
  });

  it('keeps drawing glass set down on the sea until its resting line has settled, then stops', () => {
    const { sea, run } = windowAt(60);
    sea.setActive(true);
    run(5);
    const card = { id: 1, x: 300, y: 200, width: 360, height: 180, radius: 2, rest: 0.85, hover: false, textureX: 0, textureY: 0 };
    // Glass that simply stands there draws once and asks for nothing more.
    sea.setShapes([card]);
    expect(run(1)).toBe(0);
    // Glass that arrives eases its line in for about a second, then the sea is still again.
    sea.setShapes([{ ...card, id: 2, arrive: true }]);
    const settled = run(5);
    expect(settled).toBeGreaterThan(0.8);
    expect(settled).toBeLessThan(2.5);
    // A line asked to go eases out the same way.
    sea.setShapes([{ ...card, id: 2, arrive: true, rest: 0 }]);
    expect(run(5)).toBeGreaterThan(0.8);
  });
});

