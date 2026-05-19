import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import { useUiStore, SINGLETON_TAB_ID, type TabRef } from '../store/ui-store';

const DEFAULT_PROJECT = { id: 'default-project', name: 'Default Project' };

/**
 * Project-aware navigation hook
 * Automatically includes projectId in navigation paths
 */
export function useProjectNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const currentProjectId = projectId || DEFAULT_PROJECT.id;

  // Shared helper — the actual store mutation + URL push for opening an
  // entity as a tab. We keep this as a single source of truth so both
  // openEntity (legacy callers) and navigateToX (typed wrappers) route the
  // same way. The URL switch lives here so callers don't all duplicate it.
  const pushEntityUrl = useCallback(
    (ref: TabRef) => {
      switch (ref.entityType) {
        case 'node':
          navigate(`/project/${currentProjectId}/editor/${ref.id}`);
          return;
        case 'storyline':
          navigate(`/project/${currentProjectId}/editor/storyline/${ref.id}`);
          return;
        case 'element':
          navigate(`/project/${currentProjectId}/element/${ref.id}`);
          return;
        case 'category':
          navigate(`/project/${currentProjectId}/category/${encodeURIComponent(ref.id)}`);
          return;
        case 'dashboard':
          navigate(`/project/${currentProjectId}/home`);
          return;
        case 'all-chapters':
          navigate(`/project/${currentProjectId}/editor/all`);
          return;
      }
    },
    [navigate, currentProjectId],
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

  // Reference `location` so the hook re-renders on path changes (legacy
  // call sites depend on this). The actual fast-path now uses the store.
  void location.pathname;

  return {
    projectId: currentProjectId,
    navigateToNode,
    navigateToStoryline,
    navigateToElement,
    navigateToCategory,
    navigateToHome,
    navigateToAllChapters,
    navigateTo,
    openEntity,
    activateLeafTab,
    // Also expose raw navigate for edge cases
    navigate,
  };
}
