import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useProjectTabs, useUiStore, tabKey, focusedLeafOf } from '../../store/ui-store';

// Mirror the focused leaf of whatever is the active top-level tab into the
// URL. Mounted at the Layout level so it runs regardless of whether the
// route Outlet is currently rendering (EditorShell only runs through the
// Outlet path, which is suppressed in split mode — so URL sync can't live
// there).
//
// Cases:
//   • Active is a split with focused side X → ensure URL points at X's
//     entity. Catches things like clicking the "other" sub-label in a fused
//     tab (which just changes focus in the store).
//   • Active is a leaf → ensure URL points at it. Catches transitions like
//     closing one side of a split (the surviving leaf becomes active but
//     the URL still references the just-closed side).
//   • No active tab (e.g. on the project home or the all-chapters editor
//     route) → do nothing. The URL is already authoritative.
//
// We guard against re-firing when the URL already matches so this doesn't
// trample history with redundant entries.
export function useSyncSplitFocusedUrl(): void {
  const { projectId, openEntity } = useProjectNavigation();
  const { openTabs, activeTabKey } = useProjectTabs(projectId);
  const location = useLocation();
  const setNodeSelection = useUiStore((s) => s.setNodeSelection);
  const setElementSelection = useUiStore((s) => s.setElementSelection);

  useEffect(() => {
    const active = openTabs.find((t) => tabKey(t) === activeTabKey);
    if (!active) return;
    // Some routes deliberately ignore the active-tab concept — most notably
    // /home (project dashboard) and /editor/all (whole-book scroll mode).
    // Don't yank the user out of those just because there's a stale active
    // tab from a previous session.
    if (isTabAgnosticPath(location.pathname, projectId)) return;
    const focused = focusedLeafOf(active);

    // Drive the left sidebar / timeline highlight off the focused leaf.
    // EditorShell normally does this from URL params, but it doesn't mount
    // when split is active (Outlet isn't rendered), so we have to write
    // these selections here ourselves. Source 'system' keeps the click→
    // navigate side-effect in EditorShell from re-firing.
    if (focused.entityType === 'node') {
      setNodeSelection(focused.id, 'system');
    } else if (focused.entityType === 'element') {
      setElementSelection(focused.id, 'system');
    }

    const expected = expectedPathnameFor(projectId, focused);
    if (!expected) return;
    if (location.pathname === expected) return;
    openEntity({ entityType: focused.entityType, id: focused.id });
    // openEntity is a fresh closure on every render; we only want to fire
    // when the active tab / focused side / URL diverge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabKey, openTabs, location.pathname, projectId, setNodeSelection, setElementSelection]);
}

function isTabAgnosticPath(pathname: string, projectId: string | undefined): boolean {
  if (!projectId) return true;
  if (pathname === `/project/${projectId}/home`) return true;
  if (pathname === `/project/${projectId}/editor/all`) return true;
  return false;
}

function expectedPathnameFor(
  projectId: string | undefined,
  focused: { entityType: string; id: string },
): string | null {
  if (!projectId) return null;
  switch (focused.entityType) {
    case 'node':
      return `/project/${projectId}/editor/${focused.id}`;
    case 'storyline':
      return `/project/${projectId}/editor/storyline/${focused.id}`;
    case 'element':
      return `/project/${projectId}/element/${focused.id}`;
    case 'category':
      return `/project/${projectId}/category/${encodeURIComponent(focused.id)}`;
    default:
      return null;
  }
}
