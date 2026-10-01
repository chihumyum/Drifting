import { createContext, useContext } from 'react';
import type { SidebarPaneId } from './sidebar-tabs';

export const SidebarPaneContext = createContext<SidebarPaneId | null>(null);
export const useSidebarPaneId = () => useContext(SidebarPaneContext);
