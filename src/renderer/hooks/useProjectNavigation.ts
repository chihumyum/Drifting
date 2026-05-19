import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import { useUiStore, type TabRef } from '../store/ui-store';

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

  const navigateToNode = useCallback(
    (nodeId: string) => {
      navigate(`/project/${currentProjectId}/editor/${nodeId}`);
    },
    [navigate, currentProjectId],
  );

  const navigateToStoryline = useCallback(
    (storylineId: string) => {
      navigate(`/project/${currentProjectId}/editor/storyline/${storylineId}`);
    },
    [navigate, currentProjectId],
  );

  const navigateToElement = useCallback(
    (elementId: string) => {
      navigate(`/project/${currentProjectId}/element/${elementId}`);
    },
    [navigate, currentProjectId],
  );

  const navigateToCategory = useCallback(
    (categoryId: string) => {
      navigate(`/project/${currentProjectId}/category/${categoryId}`);
    },
    [navigate, currentProjectId],
  );

  const navigateToHome = useCallback(() => {
    navigate(`/project/${currentProjectId}/home`);
  }, [navigate, currentProjectId]);

  const navigateToAllChapters = useCallback(() => {
    navigate(`/project/${currentProjectId}/editor/all`);
  }, [navigate, currentProjectId]);

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

  // VSCode-style "open as tab" entry point. Records the tab in store (with the
  // requested preview flag) and navigates to its URL. The id is the raw entity
  // id (decoded for categories); URL encoding is applied internally.
  //
  // Exception: when we're already in the all-chapters editor and the caller is
  // opening a chapter (node), don't navigate away — just mark the node as
  // selected so the all-chapters view can scroll to it. This keeps the
  // sidebar/timeline "click chapter" gesture inside the long-scroll view.
  const openEntity = useCallback(
    (ref: TabRef, options?: { preview?: boolean }) => {
      const preview = options?.preview ?? true;
      const inAllChapters = location.pathname.endsWith('/editor/all');
      if (inAllChapters && ref.entityType === 'node') {
        useUiStore.getState().setNodeSelection(ref.id, 'ui');
        return;
      }
      useUiStore.getState().openEntityTab(currentProjectId, ref, { preview });
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
      }
    },
    [navigate, currentProjectId, location.pathname],
  );

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
    // Also expose raw navigate for edge cases
    navigate,
  };
}
