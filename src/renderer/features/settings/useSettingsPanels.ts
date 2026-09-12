import { useEffect, useSyncExternalStore } from 'react';
import { createDeferredModule } from '../../lib/deferred-module';
import { loadSettingsPanels } from 'virtual:settings-panels';

const settingsPanels = createDeferredModule(loadSettingsPanels);

export function useSettingsPanels(active: boolean) {
  const state = useSyncExternalStore(settingsPanels.subscribe, settingsPanels.getSnapshot);
  useEffect(() => {
    if (active && state.status === 'idle') void settingsPanels.load();
  }, [active, state.status]);
  return {
    panels: state.status === 'ready' ? state.value : null,
    failed: state.status === 'error',
    retry: settingsPanels.load,
  };
}
