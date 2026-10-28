import { afterEach, describe, expect, it, vi } from 'vitest';
import { flowGlassSelection, restGlassWave, waveDuration, waveFrame, waveWindow } from './glass-wave';

const A = { left: 0, right: 80 };
const D = { left: 255, right: 335 };

describe('a selection that flows between sibling pills', () => {
  it('starts on the old item, lands exactly on the new one and passes the ones between', () => {
    expect(waveFrame(A, D, 0)).toEqual({ left: 0, right: 80, strength: 1, feather: 2 });
    const end = waveFrame(A, D, 1);
    expect(end.left).toBeCloseTo(255);
    expect(end.right).toBeCloseTo(335);
    expect(end.strength).toBeCloseTo(1);
    expect(end.feather).toBeCloseTo(2);
    // Mid-way the band covers the pills in between, a little wider and fainter.
    const mid = waveFrame(A, D, 0.25);
    const centre = (mid.left + mid.right) / 2;
    expect(centre).toBeGreaterThan(85);
    expect(centre).toBeLessThan(255);
    expect(mid.right - mid.left).toBeGreaterThan(80);
    expect(mid.strength).toBeLessThan(1);
    expect(mid.feather).toBeGreaterThan(2);
  });

  it('leaves fast and arrives gently', () => {
    const at = (t: number) => (waveFrame(A, D, t).left + waveFrame(A, D, t).right) / 2;
    expect(at(0.2) - at(0)).toBeGreaterThan(at(1) - at(0.8));
  });

  it('cuts each pill with a window in its own px and skips the ones it misses', () => {
    const frame = { left: 100, right: 180, strength: 0.9, feather: 10 };
    expect(waveWindow(frame, { x: 85, width: 80 })).toEqual({ a0: 5, a1: 15, b0: 95, b1: 105 });
    expect(waveWindow(frame, { x: 0, width: 80 })).toBeNull();
    expect(waveWindow(frame, { x: 200, width: 80 })).toBeNull();
    expect(waveWindow(frame, { x: 185, width: 80 })).not.toBeNull();
  });

  it('takes a little longer the further it goes, up to four pills', () => {
    expect(waveDuration(85, 85)).toBe(300);
    expect(waveDuration(-255, 85)).toBe(440);
    expect(waveDuration(2000, 85)).toBe(510);
  });
});

describe('running the band', () => {
  afterEach(() => vi.unstubAllGlobals());

  const dock = () => {
    const attributes = new Map<string, string>();
    const layer = (key: string, left: number) => {
      const values = new Map<string, string>();
      return {
        dataset: { waveKey: key },
        style: { setProperty: (name: string, value: string) => values.set(name, value) },
        getBoundingClientRect: () => ({ left, width: 80 }),
        values,
      };
    };
    const layers = [layer('a', 0), layer('b', 85), layer('c', 170), layer('d', 255)];
    const container = {
      getBoundingClientRect: () => ({ left: 0 }),
      querySelectorAll: () => layers,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as HTMLElement;
    return { container, layers, attributes };
  };

  it('lights the pills between in turn, then settles on the new one', () => {
    vi.useFakeTimers();
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('performance', { now: () => now });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const step = (ms: number) => {
      now += ms;
      frames.splice(0).forEach((cb) => cb(now));
    };
    const { container, layers, attributes } = dock();
    flowGlassSelection(container, 'a', 'd');
    expect(attributes.get('data-glass-waving')).toBe('move');
    step(16);
    expect(Number(layers[0].values.get('--wave-k'))).toBeGreaterThan(0);
    const litB = [];
    for (let t = 16; t < 440; t += 16) {
      step(16);
      litB.push(Number(layers[1].values.get('--wave-k') ?? 0));
    }
    expect(Math.max(...litB)).toBeGreaterThan(0.5);
    step(32);
    expect(layers[0].values.get('--wave-k')).toBe('0');
    expect(layers[1].values.get('--wave-k')).toBe('0');
    expect(layers[3].values.get('--wave-a1')).toBe('0.0px');
    expect(layers[3].values.get('--wave-b0')).toBe('80.0px');
    expect(attributes.get('data-glass-waving')).toBe('settle');
    vi.advanceTimersByTime(320);
    expect(attributes.has('data-glass-waving')).toBe(false);
    restGlassWave(container);
    vi.useRealTimers();
  });

  it('lets a pill chosen by pressing it keep its own bleed while the band flows in', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { container, layers, attributes } = dock();
    const pill = new Map<string, string>();
    Object.assign(layers[3], { parentElement: { setAttribute: (name: string, value: string) => pill.set(name, value) } });
    flowGlassSelection(container, 'a', 'd', true);
    expect(attributes.get('data-glass-waving')).toBe('move');
    expect(pill.has('data-wave-landed')).toBe(true);
    restGlassWave(container);
  });

  it('jumps straight to the new pill for readers who reduce motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { container, attributes } = dock();
    flowGlassSelection(container, 'a', 'd');
    expect(attributes.has('data-glass-waving')).toBe(false);
  });
});
