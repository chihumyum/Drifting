import { useCallback } from 'react';
import { useProjectNavigation } from './useProjectNavigation';
import { useSidebarPanelState } from './useSidebarPanelState';
import type { WorkspaceTarget } from '../features/workspace/navigation/workspace-target';

export function useSidebarPanelNavigation() {
  const navigation = useProjectNavigation();
  const openSharedEditor = navigation.openEntity;
  const [, select] = useSidebarPanelState<WorkspaceTarget | null>('selection', null);
  const openEntity = useCallback<typeof openSharedEditor>((target, options) => {
    select(target);
    openSharedEditor(target, options);
  }, [select, openSharedEditor]);
  return { ...navigation, openEntity };
}
