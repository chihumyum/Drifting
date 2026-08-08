import { useMemo } from 'react';
import { useUiStore } from '../store/ui-store';
import {
  useOptionalSuperViewNavigation,
  type SuperViewNavigation,
} from '../components/SuperViewNavigationContext';

export function useSuperViewNavigation(): SuperViewNavigation {
  const provided = useOptionalSuperViewNavigation();
  const active = useUiStore((state) => state.activeSuperView);
  const setActive = useUiStore((state) => state.setActiveSuperView);
  return useMemo(() => provided ?? { active, setActive }, [active, provided, setActive]);
}
