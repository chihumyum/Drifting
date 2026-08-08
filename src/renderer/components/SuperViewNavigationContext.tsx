import { createContext, useContext, type ReactNode } from 'react';

export type SuperViewId = 'element' | 'graph' | 'memo-material';

export interface SuperViewNavigation {
  active: SuperViewId | 'none';
  setActive: (view: SuperViewId | 'none') => void;
}

const SuperViewNavigationContext = createContext<SuperViewNavigation | null>(null);

export function SuperViewNavigationProvider({
  value,
  children,
}: {
  value: SuperViewNavigation;
  children: ReactNode;
}) {
  return (
    <SuperViewNavigationContext.Provider value={value}>
      {children}
    </SuperViewNavigationContext.Provider>
  );
}

export function useOptionalSuperViewNavigation(): SuperViewNavigation | null {
  return useContext(SuperViewNavigationContext);
}
