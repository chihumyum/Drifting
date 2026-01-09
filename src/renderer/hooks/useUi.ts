import { useCallback, useMemo } from 'react';
import { useUiStore } from '../store/ui-store';

/**
 * UI state management hook
 * Provides methods to update UI-related state
 */
export function useUi() {
  const isGraphViewOpen = useUiStore(state => state.isGraphViewOpen);
  
  const setGraphViewOpen = useCallback((isOpen: boolean) => {
    useUiStore.getState().setGraphViewOpen(isOpen);
  }, []);

  return useMemo(() => ({
    isGraphViewOpen,
    setGraphViewOpen,
  }), [isGraphViewOpen, setGraphViewOpen]);
}
