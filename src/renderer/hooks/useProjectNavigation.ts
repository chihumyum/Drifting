import { useNavigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
const DEFAULT_PROJECT = { id: 'default-project', name: 'Default Project' };

/**
 * Project-aware navigation hook
 * Automatically includes projectId in navigation paths
 */
export function useProjectNavigation() {
  const navigate = useNavigate();
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

  return {
    projectId: currentProjectId,
    navigateToNode,
    navigateToStoryline,
    navigateToElement,
    navigateToCategory,
    navigateToHome,
    navigateTo,
    // Also expose raw navigate for edge cases
    navigate,
  };
}
