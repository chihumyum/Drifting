import { deferredEntryPlugin } from './deferred-entry';

export function deferredSettingsPlugin() {
  return deferredEntryPlugin({
    id: 'virtual:settings-panels', entry: 'src/renderer/features/settings/settings-panels.ts',
    name: 'settings-panels', exportName: 'loadSettingsPanels', attemptParam: 'settings-attempt',
  });
}

// Standalone routes share these groups with the continuous project modal.
// Give each group its own retry key instead of retrying only an outer barrel.
export function deferredProjectSettingsPlugins() {
  return [
    ['preference', 'PreferenceSettingsPanels.tsx'],
    ['intelligence', 'IntelligenceSettingsPanels.tsx'],
    ['agent', 'AgentSettingsPanel.tsx'],
    ['control', 'AccountControlSettingsPanels.ts'],
  ].map(([name, file]) => {
    return deferredEntryPlugin({
      id: `virtual:settings-${name}`, entry: `src/renderer/features/settings/panels/${file}`,
      name: `settings-${name}`, exportName: 'loadPanels', attemptParam: `settings-${name}-attempt`,
    });
  });
}
