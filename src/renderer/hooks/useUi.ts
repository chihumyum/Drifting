import { useCallback, useMemo } from 'react';
import { useUiStore } from '../store/ui-store';

/**
 * UI state management hook
 * Provides methods to update UI-related state
 */
export function useUi() {
  const isStoryGraphViewOpen = useUiStore((state) => state.activeSuperView === 'graph');

  const setStoryGraphViewOpen = useCallback((isOpen: boolean) => {
    useUiStore.getState().setActiveSuperView(isOpen ? 'graph' : 'none');
  }, []);

  return useMemo(
    () => ({
      isStoryGraphViewOpen,
      setStoryGraphViewOpen,
    }),
    [isStoryGraphViewOpen, setStoryGraphViewOpen],
  );
}
