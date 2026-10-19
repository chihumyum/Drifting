import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAllChaptersNavigator } from './all-chapters-navigation';

function fixture() {
  const root = Object.assign(new EventTarget(), {
    isConnected: true, clientTop: 0, scrollTop: 0, scrollHeight: 30000, clientHeight: 600,
    getBoundingClientRect: () => ({ top: 40 }),
    closest: () => null,
    scrollTo: vi.fn(({ top }: { top: number }) => { root.scrollTop = top; }),
    querySelector: (selector: string) => selector.includes('data-act-id') ? act : row,
  });
  let chapterTop = 12000;
  const heading = {
    getBoundingClientRect: () => ({ top: chapterTop + 500 - root.scrollTop + 40 }),
    closest: () => null,
  };
  const row = {
    dataset: { contentReady: 'false' },
    getBoundingClientRect: () => ({ top: chapterTop - root.scrollTop + 40 }),
    querySelectorAll: () => [heading],
  };
  const act = { getBoundingClientRect: () => ({ top: chapterTop - 200 - root.scrollTop + 40 }) };
  const prepareChapter = vi.fn(async () => { row.dataset.contentReady = 'true'; });
  const navigator = createAllChaptersNavigator({
    getRoot: () => root as unknown as HTMLElement, prepareChapter,
  });
  return { root, row, heading, prepareChapter, navigator,
    shift: (delta: number) => { chapterTop += delta; } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('getComputedStyle', () => ({ scrollMarginTop: '24px', scrollPaddingTop: '24px' }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('whole-book navigation through lazy chapter layout', () => {
  it('loads a cold chapter and waits for its prose commit before locating a heading', async () => {
    const f = fixture();
    f.prepareChapter.mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => {
        resolve();
        setTimeout(() => { f.row.dataset.contentReady = 'true'; }, 50);
      }, 5000);
    }));
    const result = f.navigator.navigate({ chapterId: 'far', blockId: 'scene' });
    await vi.advanceTimersByTimeAsync(5040);
    expect(f.root.scrollTo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(true);
    expect(f.root.scrollTop).toBe(12452); // target margin + scroll padding
    expect(f.root.scrollTo).toHaveBeenCalledWith({ top: 12452, behavior: 'instant' });
  });

  it('realigns a chapter when nearby content replaces estimated height', async () => {
    const f = fixture();
    const result = f.navigator.navigate({ chapterId: 'far' });
    await vi.advanceTimersByTimeAsync(100);
    f.shift(-1800);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(true);
    expect(f.root.scrollTop).toBe(10152);
    expect(f.root.scrollTo).toHaveBeenCalledTimes(2);
  });

  it('cancels an older read when another TOC item is chosen', async () => {
    const f = fixture();
    let finishRead!: () => void;
    f.prepareChapter.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const old = f.navigator.navigate({ chapterId: 'far', blockId: 'scene' });
    const latest = f.navigator.navigate({ chapterId: 'far' });
    await vi.advanceTimersByTimeAsync(500);
    const top = f.root.scrollTop;
    finishRead();
    await vi.advanceTimersByTimeAsync(500);
    await expect(old).resolves.toBe(false);
    await expect(latest).resolves.toBe(true);
    expect(f.root.scrollTop).toBe(top);
  });

  it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])('yields to user %s input', async (type) => {
    const f = fixture();
    const result = f.navigator.navigate({ chapterId: 'far' });
    await vi.advanceTimersByTimeAsync(50);
    f.root.dispatchEvent(new Event(type));
    f.root.scrollTop = 42;
    f.shift(500);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(false);
    expect(f.root.scrollTop).toBe(42);
    expect(f.navigator.isNavigating()).toBe(false);
  });

  it('lands on an act divider after preparing its neighbouring chapter', async () => {
    const f = fixture();
    const result = f.navigator.navigate({ chapterId: 'far', actId: 'act-2' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(true);
    expect(f.root.scrollTop).toBe(11752);
  });

  it('times out a missing heading and releases navigation after cleanup', async () => {
    const f = fixture();
    f.row.querySelectorAll = () => [];
    const result = f.navigator.navigate({ chapterId: 'far', blockId: 'deleted' });
    await vi.advanceTimersByTimeAsync(3500);
    await expect(result).resolves.toBe(false);
    expect(f.root.scrollTo).not.toHaveBeenCalled();
    expect(f.navigator.isNavigating()).toBe(false);
    const pending = f.navigator.navigate({ chapterId: 'far' });
    f.navigator.cancel();
    await expect(pending).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores the hidden static copy of a focused heading', async () => {
    const f = fixture();
    const hidden = { ...f.heading, closest: () => ({}) };
    f.row.querySelectorAll = () => [hidden, f.heading] as typeof f.heading[];
    const hiddenMeasure = vi.spyOn(hidden, 'getBoundingClientRect');
    const result = f.navigator.navigate({ chapterId: 'far', blockId: 'scene' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe(true);
    expect(hiddenMeasure).not.toHaveBeenCalled();
  });
});
