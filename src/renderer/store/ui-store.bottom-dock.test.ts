import { beforeEach, describe, expect, it, vi } from 'vitest';

// The persisted store only exists where there is storage.
vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('window', { localStorage: globalThis.localStorage });
});

import { isChapterInFront, useUiStore, type AnyTab, type LeafTab } from './ui-store';

const state = () => useUiStore.getState();

beforeEach(() => useUiStore.setState({ bottomTimelineHidden: false, plotPlannerOpen: false }));

describe('the one dock under the paper', () => {
  it('opening the plot planner puts the Bottom Timeline away, and back', () => {
    state().togglePlotPlannerOpen();
    expect(state()).toMatchObject({ plotPlannerOpen: true, bottomTimelineHidden: true });
    state().toggleBottomTimelineHidden();
    expect(state()).toMatchObject({ plotPlannerOpen: false, bottomTimelineHidden: false });
    state().setPlotPlannerOpen(true);
    expect(state()).toMatchObject({ plotPlannerOpen: true, bottomTimelineHidden: true });
    state().setBottomTimelineHidden(false);
    expect(state()).toMatchObject({ plotPlannerOpen: false, bottomTimelineHidden: false });
  });

  it('closing either one leaves the dock closed', () => {
    state().togglePlotPlannerOpen();
    state().togglePlotPlannerOpen();
    expect(state()).toMatchObject({ plotPlannerOpen: false, bottomTimelineHidden: true });
    state().toggleBottomTimelineHidden();
    state().toggleBottomTimelineHidden();
    expect(state()).toMatchObject({ plotPlannerOpen: false, bottomTimelineHidden: true });
  });

  it('restores state saved when both could be open with the timeline showing', () => {
    const options = useUiStore.persist.getOptions();
    const restored = options.merge!(
      { bottomTimelineHidden: false, plotPlannerOpen: true },
      useUiStore.getInitialState(),
    ) as ReturnType<typeof state>;
    expect(restored).toMatchObject({ plotPlannerOpen: false, bottomTimelineHidden: false });
  });

  it('forgets the planner’s own height, now that it takes the Bottom Panel’s', () => {
    const options = useUiStore.persist.getOptions();
    const restored = options.merge!({ plotPlannerHeight: 320 }, useUiStore.getInitialState());
    expect(restored).not.toHaveProperty('plotPlannerHeight');
    expect(options.partialize!(state())).not.toHaveProperty('plotPlannerHeight');
  });

  it('has the planner only while a chapter or drift is the focused page', () => {
    const leaf = (entityType: LeafTab['entityType'], id: string) =>
      ({ kind: 'leaf', entityType, id, isPreview: false }) as LeafTab;
    const tabs = (openTabs: AnyTab[], activeTabKey: string | null) =>
      ({ openTabs, activeTabKey, lastActiveContentTabKey: null });
    expect(isChapterInFront(undefined)).toBe(false);
    expect(isChapterInFront(tabs([leaf('node', 'n1')], null))).toBe(false);
    expect(isChapterInFront(tabs([leaf('node', 'n1')], 'node:n1'))).toBe(true);
    expect(isChapterInFront(tabs([leaf('storyline', 's1')], 'storyline:s1'))).toBe(false);
    expect(isChapterInFront(tabs([leaf('all-chapters', 'all')], 'all-chapters:all'))).toBe(false);
    const split = { kind: 'split' as const, id: 'p', left: leaf('node', 'n1'), right: leaf('storyline', 's1'), splitRatio: 0.5 };
    expect(isChapterInFront(tabs([{ ...split, focused: 'left' }], 'split:p'))).toBe(true);
    expect(isChapterInFront(tabs([{ ...split, focused: 'right' }], 'split:p'))).toBe(false);
  });
});
