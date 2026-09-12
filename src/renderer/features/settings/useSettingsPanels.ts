import { useEffect, useSyncExternalStore } from 'react';
import { useDeferredModuleIntent } from '../../hooks/useDeferredModuleIntent';
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

export function useSettingsPreloadIntent(enabled = true) {
  return useDeferredModuleIntent(enabled ? settingsPanels : undefined);
}
