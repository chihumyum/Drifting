import { createContext, useContext, type ReactNode } from 'react';
import type { WorkspaceNavigator } from './workspace-target';

const WorkspaceNavigationContext = createContext<WorkspaceNavigator | null>(null);

export function WorkspaceNavigationProvider({
  navigator,
  children,
}: {
  navigator: WorkspaceNavigator;
  children: ReactNode;
}) {
  return (
    <WorkspaceNavigationContext.Provider value={navigator}>
      {children}
    </WorkspaceNavigationContext.Provider>
  );
}

export function useWorkspaceNavigator(): WorkspaceNavigator {
  const navigator = useContext(WorkspaceNavigationContext);
  if (!navigator) throw new Error('WorkspaceNavigator is not available outside an app shell');
  return navigator;
}
