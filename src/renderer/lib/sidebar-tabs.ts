export const LEFT_SIDEBAR_TABS = ['nodes', 'elements', 'drift'] as const;
export const RIGHT_SIDEBAR_TABS = ['review', 'library', 'stats', 'companion'] as const;
export type LeftSidebarTab = (typeof LEFT_SIDEBAR_TABS)[number];
export type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];

// Stable identities, not positions: closing the first pane leaves the second
// mounted, even when it expands to occupy the entire sidebar.
export type SidebarPaneId = 'primary' | 'secondary';
export interface SidebarPane<T extends string> {
  id: SidebarPaneId;
  tab: T;
}
// Which end of the tab row offers the split, and where the second pane
// arrives: the side of the half the author last closed (default: the end).
export type SidebarSplitEdge = 'start' | 'end';
export interface SidebarTabs<T extends string> {
  panes: SidebarPane<T>[];
  focusedPane: SidebarPaneId;
  // Reopening a deliberately single wide sidebar must not undo that choice.
  canSplit: boolean;
  splitEdge?: SidebarSplitEdge;
  // The author went back to one column while two fitted: crossing the width
  // threshold again keeps that choice instead of splitting automatically.
  // Cleared when they split by hand.
  keepSingle?: boolean;
}

export function singleSidebarTab<T extends string>(tab: T): SidebarTabs<T> {
  return { panes: [{ id: 'primary', tab }], focusedPane: 'primary', canSplit: false };
}

export function focusedSidebarTab<T extends string>(state: SidebarTabs<T>): T {
  return (state.panes.find((pane) => pane.id === state.focusedPane) ?? state.panes[0]).tab;
}

export function splitSidebarTabs<T extends string>(
  state: SidebarTabs<T>,
  order: readonly T[],
): SidebarTabs<T> {
  if (!state.canSplit || state.panes.length === 2) return state;
  const current = state.panes[0];
  const next = order[(order.indexOf(current.tab) + 1) % order.length];
  const added = { id: current.id === 'primary' ? 'secondary' : 'primary', tab: next } as const;
  const split: SidebarTabs<T> = {
    ...state,
    panes: state.splitEdge === 'start' ? [added, current] : [current, added],
  };
  delete split.keepSingle;
  return split;
}

export function resizeSidebarTabs<T extends string>(
  state: SidebarTabs<T>,
  canSplit: boolean,
  order: readonly T[],
): SidebarTabs<T> {
  if (state.canSplit === canSplit) return state;
  if (canSplit) return state.keepSingle ? { ...state, canSplit } : splitSidebarTabs({ ...state, canSplit }, order);
  const pane = state.panes.find((item) => item.id === state.focusedPane) ?? state.panes[0];
  return { ...state, panes: [pane], focusedPane: pane.id, canSplit };
}

/** null closes the sidebar; its last pane is retained for reopening. */
export function toggleSidebarTab<T extends string>(
  state: SidebarTabs<T>,
  paneId: SidebarPaneId,
  tab: T,
): SidebarTabs<T> | null {
  const current = state.panes.find((pane) => pane.id === paneId);
  if (!current) return state;
  if (current.tab === tab) {
    const panes = state.panes.filter((pane) => pane.id !== paneId);
    if (!panes.length) return null;
    // Splitting again brings the closed half back on the same side; until
    // then a wide sidebar stays single.
    const splitEdge = state.panes.indexOf(current) === 0 ? 'start' : 'end';
    return { ...state, panes, focusedPane: panes[0].id, splitEdge, keepSingle: true };
  }
  return {
    ...state,
    panes: state.panes.map((pane) => pane.id === paneId ? { ...pane, tab } : pane),
    focusedPane: paneId,
  };
}

/** Explicit navigation reuses an existing destination or replaces the focused pane. */
export function revealSidebarTab<T extends string>(state: SidebarTabs<T>, tab: T): SidebarTabs<T> {
  const current = state.panes.find((pane) => pane.id === state.focusedPane)!;
  const existing = current.tab === tab ? current : state.panes.find((pane) => pane.tab === tab);
  if (existing) return { ...state, focusedPane: existing.id };
  return {
    ...state,
    panes: state.panes.map((pane) => pane.id === state.focusedPane ? { ...pane, tab } : pane),
  };
}

export function restoreSidebarTabs<T extends string>(
  value: unknown,
  fallback: T,
  order: readonly T[],
): SidebarTabs<T> {
  if (!value || typeof value !== 'object') return singleSidebarTab(fallback);
  const saved = value as Record<string, unknown>;
  const canSplit = saved.canSplit === true;
  const panes: SidebarPane<T>[] = [];
  if (Array.isArray(saved.panes)) {
    for (const item of saved.panes) {
      if (!item || typeof item !== 'object') continue;
      const { id, tab } = item;
      if ((id !== 'primary' && id !== 'secondary') || !order.includes(tab)) continue;
      if (!panes.some((pane) => pane.id === id)) panes.push({ id, tab });
      if (panes.length === (canSplit ? 2 : 1)) break;
    }
  } else if (Array.isArray(saved.tabs)) {
    // Preserve selections from the previous shared TabRow preference.
    for (const tab of saved.tabs) {
      if (!order.includes(tab)) continue;
      panes.push({ id: panes.length ? 'secondary' : 'primary', tab });
      if (panes.length === (canSplit ? 2 : 1)) break;
    }
  }
  if (!panes.length) return singleSidebarTab(fallback);
  const focused = panes.find((pane) => pane.id === saved.focusedPane)
    ?? panes.find((pane) => pane.tab === saved.focused) ?? panes[0];
  const restored: SidebarTabs<T> = { panes, focusedPane: focused.id, canSplit };
  if (saved.splitEdge === 'start' || saved.splitEdge === 'end') restored.splitEdge = saved.splitEdge;
  if (saved.keepSingle === true) restored.keepSingle = true;
  return restored;
}
