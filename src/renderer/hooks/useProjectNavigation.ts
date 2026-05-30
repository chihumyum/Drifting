import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import {
  useUiStore,
  SINGLETON_TAB_ID,
  tabKey,
  focusedLeafOf,
  type TabRef,
} from '../store/ui-store';

const DEFAULT_PROJECT = { id: 'default-project', name: 'Default Project' };

// Pure URL builder. Exposed via the module scope so the dedupe check in
// pushEntityUrl can compare against location.pathname without rebuilding
// the URL via navigate's internals.
function urlFor(projectId: string, ref: TabRef): string | null {
  switch (ref.entityType) {
    case 'node':
      return `/project/${projectId}/editor/${ref.id}`;
    case 'storyline':
      return `/project/${projectId}/editor/storyline/${ref.id}`;
    case 'element':
      return `/project/${projectId}/element/${ref.id}`;
    case 'category':
      return `/project/${projectId}/category/${encodeURIComponent(ref.id)}`;
    case 'dashboard':
      return `/project/${projectId}/home`;
    case 'all-chapters':
      return `/project/${projectId}/editor/all`;
    default:
      return null;
  }
}

/**
 * Project-aware navigation hook
 * Automatically includes projectId in navigation paths
 */
export function useProjectNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const currentProjectId = projectId || DEFAULT_PROJECT.id;

  // Shared helper — the actual URL push for opening an entity as a tab.
  // Kept as a single source of truth so both openEntity (legacy callers)
  // and navigateToX (typed wrappers) route the same way.
  //
  // We skip the navigate when the target URL already equals the current
  // pathname. Otherwise a double-click (which fires onClick twice before
  // onDoubleClick) would push the same URL into history twice, and the
  // user has to press Cmd+[ twice per "back" step. Any caller that wants
  // to *force* a history entry can use `navigate` directly.
  const pushEntityUrl = useCallback(
    (ref: TabRef) => {
      const target = urlFor(currentProjectId, ref);
      if (!target) return;
      if (target === location.pathname) return;
      navigate(target);
    },
    [navigate, currentProjectId, location.pathname],
  );

  // VSCode-style "open as tab" entry point. Records the tab in store (with the
  // requested preview flag) and navigates to its URL. The id is the raw entity
  // id (decoded for categories); URL encoding is applied internally.
  //
  // openEntity is uniform across all views — there is no longer a special
  // "if the user is in 通览全书, scroll-in-place instead of switching tabs"
  // path. Sidebar / timeline clicks while reading the long-scroll view
  // navigate away just like they would from any other editor. The
  // long-scroll view's own outline panel handles in-view chapter jumps via
  // a hierarchical TOC.
  const openEntity = useCallback(
    (ref: TabRef, options?: { preview?: boolean }) => {
      const preview = options?.preview ?? true;
      useUiStore.getState().openEntityTab(currentProjectId, ref, { preview });
      pushEntityUrl(ref);
    },
    [currentProjectId, pushEntityUrl],
  );

  const navigateToNode = useCallback(
    (nodeId: string) => openEntity({ entityType: 'node', id: nodeId }),
    [openEntity],
  );

  const navigateToStoryline = useCallback(
    (storylineId: string) => openEntity({ entityType: 'storyline', id: storylineId }),
    [openEntity],
  );

  const navigateToElement = useCallback(
    (elementId: string) => openEntity({ entityType: 'element', id: elementId }),
    [openEntity],
  );

  const navigateToCategory = useCallback(
    (categoryId: string) => openEntity({ entityType: 'category', id: categoryId }),
    [openEntity],
  );

  // Singletons open with the same preview semantics as other entities:
  // first click lands as a preview tab (replacing any other preview), and
  // double-clicking the tab in the bar promotes it to dedicated. Aligns
  // with the rest of the entity bar instead of being a weird always-pinned
  // exception.
  const navigateToHome = useCallback(
    () => openEntity({ entityType: 'dashboard', id: SINGLETON_TAB_ID }),
    [openEntity],
  );

  const navigateToAllChapters = useCallback(
    () => openEntity({ entityType: 'all-chapters', id: SINGLETON_TAB_ID }),
    [openEntity],
  );

  // Where to land after the entity you were viewing got deleted. The delete
  // usecase has already closed its tab(s) and the store promoted whichever
  // sibling tab should take over (or none). Follow that: switch to the
  // promoted tab if there is one, otherwise drop to the bare project URL so
  // the empty editor surface shows. Deliberately does NOT fall back to the
  // dashboard — opening a dashboard tab the user never asked for is a bug
  // (see TopTimeline.handleCloseTab for the same "don't re-spawn dashboard"
  // rule).
  const leaveDeletedEntity = useCallback(() => {
    const project = useUiStore.getState().tabsByProject[currentProjectId];
    const active = project?.openTabs.find((t) => tabKey(t) === project.activeTabKey);
    const leaf = active ? focusedLeafOf(active) : null;
    if (leaf) {
      openEntity({ entityType: leaf.entityType, id: leaf.id });
    } else {
      navigate(`/project/${currentProjectId}`, { replace: true });
    }
  }, [currentProjectId, openEntity, navigate]);

  const navigateTo = useCallback(
    (path: string) => {
      // If path starts with /, use it as-is; otherwise prepend project context
      if (path.startsWith('/')) {
        navigate(path);
      } else {
        navigate(`/project/${currentProjectId}/${path}`);
      }
    },
    [navigate, currentProjectId],
  );

  // Activate an existing tab without going through the "in-all-chapters
  // scroll" fast-path or the split-replace-focused-side semantics. Used by
  // the tab bar: clicking a node tab in the bar should switch to it even
  // if the user is currently in the all-chapters reading mode.
  const activateLeafTab = useCallback(
    (ref: TabRef) => {
      useUiStore.getState().setActiveTab(currentProjectId, ref);
      pushEntityUrl(ref);
    },
    [currentProjectId, pushEntityUrl],
  );

  return {
    projectId: currentProjectId,
    navigateToNode,
    navigateToStoryline,
    navigateToElement,
    navigateToCategory,
    navigateToHome,
    navigateToAllChapters,
    leaveDeletedEntity,
    navigateTo,
    openEntity,
    activateLeafTab,
    // Also expose raw navigate for edge cases
    navigate,
  };
}
