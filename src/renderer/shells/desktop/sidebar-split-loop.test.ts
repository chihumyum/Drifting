import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('window', { localStorage: globalThis.localStorage });
});

import { useUiStore } from '../../store/ui-store';
import { useSidebarMetricsStore } from '../../store/sidebar-metrics-store';
import { sidebarSplitMinWidth, sidebarSplitRoom, type SidebarSplitRoom } from '../../lib/layout-geometry';
import type { SidebarPaneId } from '../../lib/sidebar-tabs';

// Synthetic tab rows: every row shows all four right tabs; the row of the last
// pane also carries the sidebar toggle (SidebarHeaderChrome).
const TABS_ONLY = 183;
const WITH_TOGGLE = 219;

const ui = () => useUiStore.getState();
const metrics = () => useSidebarMetricsStore.getState();
const panes = () => ui().desktopSidebarTabs.right.panes.map((pane) => `${pane.id}:${pane.tab}`);

type Decide = (width: number) => void;

/** DesktopSidebarLayout's split decision as it shipped in 0.1.0-alpha.10/11. */
const thresholdOnly: Decide = (width) => {
  ui().setSidebarSplitAvailable('right', width >= sidebarSplitMinWidth(metrics().minimumWidths.right));
};

/** The decision now: the same threshold behind the narrowing latch. */
function latched(): Decide {
  let narrowedAt: SidebarSplitRoom['narrowedAt'] = null;
  return (width) => {
    const split = ui().desktopSidebarTabs.right.canSplit;
    const room = sidebarSplitRoom({ split, narrowedAt }, width, metrics().minimumWidths.right);
    narrowedAt = room.narrowedAt;
    ui().setSidebarSplitAvailable('right', room.split);
  };
}

/**
 * Replays the synchronous commit chain of the right sidebar at a fixed width,
 * the way React runs it: the layout decides; the panes it asks for mount or
 * unmount their tab rows, which report or clear their minimum; a changed
 * minimum re-runs the layout's effect. `rowsFollowToggle` is whether a row that
 * gains or loses the toggle re-measures in that commit; when it doesn't, its
 * report waits for a MutationObserver, which only runs after the chain ends.
 * Returns how many commits changed the panes before the chain settled.
 */
function runChain(width: number, decide: Decide, rowsFollowToggle: boolean, limit = 60): number {
  let flips = 0;
  for (let commit = 0; commit < limit; commit += 1) {
    const before = ui().desktopSidebarTabs.right.panes.map((pane) => pane.id);
    const minimum = metrics().minimumWidths.right;
    decide(width);
    const after = ui().desktopSidebarTabs.right.panes.map((pane) => pane.id);
    const last = after[after.length - 1];
    for (const id of before) if (!after.includes(id)) metrics().clearMinimumWidth('right', id);
    for (const id of after) {
      const toggleMoved = before.includes(id) && (before[before.length - 1] === id) !== (last === id);
      if (!before.includes(id) || (toggleMoved && rowsFollowToggle)) {
        metrics().setMinimumWidth('right', id === last ? WITH_TOGGLE : TABS_ONLY, id);
      }
    }
    if (before.join() !== after.join()) flips += 1;
    // React re-runs the layout's effect only when the minimum it reads changed.
    if (before.join() === after.join() && metrics().minimumWidths.right === minimum) return flips;
  }
  return flips;
}

/** Observers run after the chain: every row reports what it shows now. */
function flushRowObservers() {
  const ids = ui().desktopSidebarTabs.right.panes.map((pane) => pane.id);
  ids.forEach((id: SidebarPaneId, index) => {
    metrics().setMinimumWidth('right', index === ids.length - 1 ? WITH_TOGGLE : TABS_ONLY, id);
  });
}

/** Agent open in a right sidebar wide enough for two: it split into Agent + Review. */
function splitWithAgentFocused() {
  useUiStore.setState(useUiStore.getInitialState(), true);
  useSidebarMetricsStore.setState({ minimumWidths: { left: 0, right: 0 }, reports: { left: {}, right: {} } });
  ui().setSidebarOpen('right', true);
  ui().toggleRightSidebarTab('primary', 'companion');
  metrics().setMinimumWidth('right', WITH_TOGGLE, 'primary');
  expect(runChain(700, latched(), true)).toBe(1);
  flushRowObservers();
  expect(panes()).toEqual(['primary:companion', 'secondary:review']);
  // The Agent pane gave the toggle to Review, so its own row is narrower now.
  expect(metrics().reports.right).toEqual({ primary: TABS_ONLY, secondary: WITH_TOGGLE });
}

describe('narrowing a split sidebar (React #185 on 0.1.0-alpha.10/11)', () => {
  beforeEach(splitWithAgentFocused);

  // Between the two thresholds the merged Agent pane still holds the report it
  // made without the toggle, so a bare threshold splits again; Review brings
  // the toggle back and the sidebar merges again, inside one commit chain.
  const between = [sidebarSplitMinWidth(TABS_ONLY), 420, sidebarSplitMinWidth(WITH_TOGGLE) - 1];

  it('reproduces the shipped loop: stale rows and a bare threshold never settle', () => {
    for (const width of between) {
      splitWithAgentFocused();
      expect(runChain(width, thresholdOnly, false)).toBeGreaterThan(50);
    }
  });

  it('settles in one merge when the rows re-measure as the toggle moves', () => {
    for (const width of between) {
      splitWithAgentFocused();
      expect(runChain(width, thresholdOnly, true)).toBe(1);
      expect(panes()).toEqual(['primary:companion']);
      expect(metrics().minimumWidths.right).toBe(WITH_TOGGLE);
    }
  });

  it('settles in one merge even with stale rows once the split decision is latched', () => {
    for (const width of between) {
      splitWithAgentFocused();
      const decide = latched();
      expect(runChain(width, decide, false)).toBe(1);
      expect(panes()).toEqual(['primary:companion']);
      flushRowObservers();
      expect(runChain(width, decide, false)).toBe(0);
      expect(panes()).toEqual(['primary:companion']);
      // Room for two again: the same sidebar splits as before.
      expect(runChain(sidebarSplitMinWidth(WITH_TOGGLE), decide, false)).toBe(1);
      expect(panes()).toEqual(['primary:companion', 'secondary:review']);
    }
  });
});

describe('sidebar tab rows follow the toggle', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('re-measures a row in the commit that moves the toggle onto or off it', () => {
    const hook = source('../../hooks/useSidebarTabMinimumWidth.ts');
    expect(hook).toContain('export function useSidebarTabMinimumWidth(side: SidebarSide, windowChrome = false)');
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \{\n {4}measureNow\.current\(\);\n {2}\}, \[windowChrome\]\);/);
    expect(source('../../components/rightBars/RightSidebarHeader.tsx'))
      .toContain("useSidebarTabMinimumWidth('right', windowChrome)");
    expect(source('../../components/leftBars/LeftSidebarHeader.tsx'))
      .toContain("useSidebarTabMinimumWidth('left', windowChrome)");
    expect(source('./DesktopSidebarLayout.tsx'))
      .toContain('sidebarSplitRoom({ split, narrowedAt: narrowedAt.current }, node.clientWidth, minimumWidth)');
  });
});
