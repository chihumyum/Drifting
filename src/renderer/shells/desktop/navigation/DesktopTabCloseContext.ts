import { createContext, useContext } from 'react';

import type { CloseDesktopWorkspaceTab } from './DesktopTabCloseTransition';

export const DesktopTabCloseContext = createContext<CloseDesktopWorkspaceTab | null>(null);

export function useDesktopTabClose(): CloseDesktopWorkspaceTab {
  const closeWorkspaceTab = useContext(DesktopTabCloseContext);
  if (!closeWorkspaceTab) {
    throw new Error('Desktop tab close transition is unavailable outside the desktop shell');
  }
  return closeWorkspaceTab;
}
