import { describe, expect, it } from 'vitest';
import {
  createMobileAllChaptersLoader,
  isMobileAllChaptersTap,
  mobileAllChaptersLivePlan,
  readMobileAllChaptersPosition,
  writeMobileAllChaptersPosition,
} from './mobile-all-chapters';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('Mobile V2 all-chapters invariants', () => {
  it.each([100, 300])('plans at most one live editor for %i chapters', (count) => {
    const ids = Array.from({ length: count }, (_, index) => `chapter-${index}`);
    const plan = mobileAllChaptersLivePlan(ids, `chapter-${count - 1}`);
    expect(plan.filter(Boolean)).toHaveLength(1);
    expect(plan[count - 1]).toBe(true);
    expect(mobileAllChaptersLivePlan(ids, 'missing').filter(Boolean)).toHaveLength(0);
  });

  it('distinguishes an intentional touch from scrolling or a long press', () => {
    expect(
      isMobileAllChaptersTap({
        startX: 20,
        startY: 100,
        startTime: 10,
        clientX: 25,
        clientY: 104,
        time: 220,
      }),
    ).toBe(true);
    expect(
      isMobileAllChaptersTap({
        startX: 20,
        startY: 100,
        startTime: 10,
        clientX: 21,
        clientY: 118,
        time: 120,
      }),
    ).toBe(false);
    expect(
      isMobileAllChaptersTap({
        startX: 20,
        startY: 100,
        startTime: 10,
        clientX: 20,
        clientY: 100,
        time: 700,
      }),
    ).toBe(false);
  });

  it('bounds and deduplicates 300 asynchronous chapter loads', async () => {
    let active = 0;
    let peak = 0;
    const loader = createMobileAllChaptersLoader(async (key: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return key;
    });
    const requests = Array.from({ length: 300 }, (_, index) => loader(`chapter-${index}`));
    const duplicate = loader('chapter-0');
    await expect(Promise.all([...requests, duplicate])).resolves.toHaveLength(301);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it('restores outline, focus, and caret intent across a process restart', () => {
    const storage = memoryStorage();
    expect(
      writeMobileAllChaptersPosition(
        'project-a',
        { outlineId: 'heading-4', focusNodeId: 'chapter-8', caretIntent: 'restore-selection' },
        storage,
      ),
    ).toBe(true);
    expect(readMobileAllChaptersPosition('project-a', storage)).toEqual({
      outlineId: 'heading-4',
      focusNodeId: 'chapter-8',
      caretIntent: 'restore-selection',
    });
  });

  it('fails closed for malformed or quota-blocked storage', () => {
    expect(readMobileAllChaptersPosition('p', { getItem: () => '{broken' })).toBeNull();
    expect(
      writeMobileAllChaptersPosition(
        'p',
        { outlineId: null, focusNodeId: null, caretIntent: null },
        { setItem: () => { throw new Error('quota'); } },
      ),
    ).toBe(false);
  });
});
