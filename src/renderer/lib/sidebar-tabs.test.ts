import { describe, expect, it } from 'vitest';
import {
  LEFT_SIDEBAR_TABS, RIGHT_SIDEBAR_TABS, focusedSidebarTab,
  resizeSidebarTabs, restoreSidebarTabs, revealSidebarTab,
  singleSidebarTab, splitSidebarTabs, toggleSidebarTab,
} from './sidebar-tabs';

describe.each([
  ['left', LEFT_SIDEBAR_TABS], ['right', RIGHT_SIDEBAR_TABS],
] as const)('%s independent sidebar panes', (_side, order: readonly string[]) => {
  it.each(order)('keeps %s on the left and adds its next tab on the right, wrapping at the end', (tab) => {
    const wide = resizeSidebarTabs(singleSidebarTab(tab), true, order);
    expect(wide.panes.map((pane) => pane.tab)).toEqual([
      tab, order[(order.indexOf(tab) + 1) % order.length],
    ]);
    expect(focusedSidebarTab(wide)).toBe(tab);
  });

  it('switches either pane directly without reordering or changing its neighbor', () => {
    const wide = resizeSidebarTabs(singleSidebarTab(order[0]), true, order);
    const next = toggleSidebarTab(wide, 'primary', order[2])!;
    expect(next.panes.map((pane) => pane.tab)).toEqual([order[2], order[1]]);
    expect(next.panes[1]).toBe(wide.panes[1]);
    expect(next.panes[0].id).toBe(wide.panes[0].id);
  });

  it('allows duplicates and closes only the pane whose current tab was clicked', () => {
    const wide = resizeSidebarTabs(singleSidebarTab(order[0]), true, order);
    const duplicate = toggleSidebarTab(wide, 'secondary', order[0])!;
    expect(duplicate.panes.map((pane) => pane.tab)).toEqual([order[0], order[0]]);
    const survivor = toggleSidebarTab(duplicate, 'primary', order[0])!;
    expect(survivor.panes).toEqual([duplicate.panes[1]]);
    expect(survivor.panes[0]).toBe(duplicate.panes[1]);
    expect(toggleSidebarTab(survivor, 'secondary', order[0])).toBeNull();
  });

  it('switches a single wide pane without splitting and explicitly restores a second pane', () => {
    const wide = resizeSidebarTabs(singleSidebarTab(order[0]), true, order);
    const single = toggleSidebarTab(wide, 'primary', order[0])!;
    const switched = toggleSidebarTab(single, 'secondary', order[2])!;
    expect(switched.panes).toEqual([{ id: 'secondary', tab: order[2] }]);
    expect(resizeSidebarTabs(switched, true, order)).toBe(switched);
    const split = splitSidebarTabs(switched, order);
    expect(split.panes[0]).toBe(switched.panes[0]);
    expect(split.panes[1].id).toBe('primary');
    expect(split.panes[1].tab).toBe(order[(2 + 1) % order.length]);
  });

  it('retains the focused pane when narrowed, then automatically splits only on crossing back', () => {
    const wide = resizeSidebarTabs(singleSidebarTab(order[0]), true, order);
    const focused = { ...wide, focusedPane: 'secondary' as const };
    const narrow = resizeSidebarTabs(focused, false, order);
    expect(narrow.panes[0]).toBe(wide.panes[1]);
    expect(splitSidebarTabs(narrow, order)).toBe(narrow);
    expect(resizeSidebarTabs(narrow, true, order).panes.map((pane) => pane.tab))
      .toEqual([order[1], order[2]]);
  });

  it('reuses an existing navigation destination and otherwise replaces only the focused pane', () => {
    const wide = resizeSidebarTabs(singleSidebarTab(order[0]), true, order);
    const existing = revealSidebarTab(wide, order[1]);
    expect(existing.panes).toBe(wide.panes);
    expect(existing.focusedPane).toBe('secondary');
    expect(revealSidebarTab(existing, order[2]).panes.map((pane) => pane.tab))
      .toEqual([order[0], order[2]]);
  });

  it('round-trips duplicate panes, preserves old selections and rejects duplicate identities', () => {
    const duplicate = {
      panes: [{ id: 'primary' as const, tab: order[1] }, { id: 'secondary' as const, tab: order[1] }],
      focusedPane: 'secondary' as const, canSplit: true,
    };
    expect(restoreSidebarTabs(duplicate, order[0], order)).toEqual(duplicate);
    expect(restoreSidebarTabs({ ...duplicate, panes: [duplicate.panes[0], duplicate.panes[0]] }, order[0], order).panes)
      .toEqual([duplicate.panes[0]]);
    expect(restoreSidebarTabs({ tabs: [order[2], order[0]], focused: order[0], canSplit: true }, order[1], order))
      .toEqual({ panes: [{ id: 'primary', tab: order[2] }, { id: 'secondary', tab: order[0] }], focusedPane: 'secondary', canSplit: true });
    expect(restoreSidebarTabs({ panes: [{ id: 'invalid', tab: 'invalid' }] }, order[0], order))
      .toEqual(singleSidebarTab(order[0]));
  });
});
