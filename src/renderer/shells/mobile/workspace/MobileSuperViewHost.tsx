import { useMemo } from 'react';
import { SuperViewNavigationProvider } from '../../../components/SuperViewNavigationContext';
import { SuperElementView } from '../../../views/SuperViews/SuperElementView';
import { StoryGraphView } from '../../../views/StoryGraphView';
import { SuperMemoMaterialView } from '../../../views/SuperViews/SuperMemoMaterialView';
import type { MobileSuperViewId } from './MobileTabOverview';

export function MobileSuperViewHost({
  active,
  onActiveChange,
}: {
  active: MobileSuperViewId | null;
  onActiveChange: (view: MobileSuperViewId | null) => void;
}) {
  const navigation = useMemo(
    () => ({
      active: active ?? ('none' as const),
      setActive: (view: MobileSuperViewId | 'none') =>
        onActiveChange(view === 'none' ? null : view),
    }),
    [active, onActiveChange],
  );
  if (!active) return null;
  return (
    <div className="m-super-view-host">
      <SuperViewNavigationProvider value={navigation}>
        {active === 'element' && <SuperElementView />}
        {active === 'graph' && <StoryGraphView />}
        {active === 'memo-material' && <SuperMemoMaterialView />}
      </SuperViewNavigationProvider>
    </div>
  );
}
