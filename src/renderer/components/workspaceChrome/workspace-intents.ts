import { useUiStore } from '../../store/ui-store';
import type { SidebarPaneId } from '../../lib/sidebar-tabs';

/**
 * What shared controls ask the workspace for, read and written outside React.
 * The paper's toolbar (plot planner), the timeline toggle, panel headers and
 * Project Home ask through the desktop's UI store; a shell that owns these
 * places itself (the phone's desk, docs/mobile-ui-foundation.md) follows the
 * requests here and writes back what it shows, so both sides agree.
 */

export type BottomPaneIntent = 'timeline' | 'planner' | null;
export type SuperViewIntent = 'element' | 'graph' | 'memo-material' | null;

type UiState = ReturnType<typeof useUiStore.getState>;

function bottomPaneOf(state: UiState): BottomPaneIntent {
  if (state.plotPlannerOpen) return 'planner';
  return state.bottomTimelineHidden ? null : 'timeline';
}

function superViewOf(state: UiState): SuperViewIntent {
  return state.activeSuperView === 'none' ? null : state.activeSuperView;
}

export function readBottomPaneIntent(): BottomPaneIntent {
  return bottomPaneOf(useUiStore.getState());
}

export function setBottomPaneIntent(pane: BottomPaneIntent): void {
  const state = useUiStore.getState();
  if (bottomPaneOf(state) === pane) return;
  if (pane === 'planner') {
    if (!state.plotPlannerOpen) state.togglePlotPlannerOpen();
    return;
  }
  if (state.plotPlannerOpen) state.togglePlotPlannerOpen();
  useUiStore.getState().setBottomTimelineHidden(pane !== 'timeline');
}

export function subscribeBottomPaneIntent(listener: (pane: BottomPaneIntent) => void): () => void {
  let previous = readBottomPaneIntent();
  return useUiStore.subscribe((state) => {
    const next = bottomPaneOf(state);
    if (next === previous) return;
    previous = next;
    listener(next);
  });
}

export function readSuperViewIntent(): SuperViewIntent {
  return superViewOf(useUiStore.getState());
}

export function setSuperViewIntent(view: SuperViewIntent): void {
  if (readSuperViewIntent() === view) return;
  useUiStore.getState().setActiveSuperView(view ?? 'none');
}

export function subscribeSuperViewIntent(listener: (view: SuperViewIntent) => void): () => void {
  let previous = readSuperViewIntent();
  return useUiStore.subscribe((state) => {
    const next = superViewOf(state);
    if (next === previous) return;
    previous = next;
    listener(next);
  });
}

/** Arriving at Project Home floats its new-entity row ('new') or its Agent ('home'). */
export function markProjectHomeArrival(intent: 'new' | 'home'): void {
  useUiStore.getState().markProjectHomeEntry(intent);
}

/**
 * The right-sidebar pane the desktop routes Agent tasks into. A phone shows
 * its one Agent panel as that pane, so a task routed there is the
 * conversation on screen.
 */
export function useAgentPaneId(): SidebarPaneId {
  return useUiStore((state) => state.desktopSidebarTabs.right.focusedPane);
}
