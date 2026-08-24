import { describe, expect, it, vi } from 'vitest';
import {
  collectMobilePaperSearchMatches,
  mobilePaperSearchScrollTop,
  registerMobilePaperSearchOwner,
  getMobilePaperSearchOwner,
  type MobilePaperSearchOwner,
} from './mobile-paper-search';

describe('Mobile V2 current-paper search ownership', () => {
  it('collects literal case-insensitive matches without crossing text nodes', () => {
    const runs = [
      { text: 'Rain rain', position: 2 },
      { text: 'RAIN', position: 20 },
    ];
    expect(collectMobilePaperSearchMatches(runs, 'rain')).toEqual([
      { from: 2, to: 6 },
      { from: 7, to: 11 },
      { from: 20, to: 24 },
    ]);
    expect(runs).toEqual([
      { text: 'Rain rain', position: 2 },
      { text: 'RAIN', position: 20 },
    ]);
  });

  it('centers a match inside the paper scroller without scrolling the page', () => {
    expect(
      mobilePaperSearchScrollTop({
        scrollTop: 320,
        viewportTop: 80,
        viewportHeight: 500,
        targetTop: 530,
        targetHeight: 20,
      }),
    ).toBe(530);
    expect(
      mobilePaperSearchScrollTop({
        scrollTop: 0,
        viewportTop: 100,
        viewportHeight: 600,
        targetTop: 120,
        targetHeight: 20,
      }),
    ).toBe(0);
  });

  it('hands the unified bar one active owner and clears it on unregister', () => {
    const clear = vi.fn();
    const owner = {
      id: 'node:a',
      clear,
      getSnapshot: () => ({ status: 'idle' as const, query: '', currentIndex: 0, total: 0 }),
      subscribe: () => () => undefined,
      setQuery: vi.fn(),
      previous: vi.fn(),
      next: vi.fn(),
    } satisfies MobilePaperSearchOwner;
    const unregister = registerMobilePaperSearchOwner(owner);
    expect(getMobilePaperSearchOwner()).toBe(owner);
    unregister();
    expect(clear).toHaveBeenCalledOnce();
    expect(getMobilePaperSearchOwner()).toBeNull();
  });
});
