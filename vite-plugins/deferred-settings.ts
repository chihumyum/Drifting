import { deferredEntryPlugin } from './deferred-entry';

export function deferredSettingsPlugin() {
  return deferredEntryPlugin({
    id: 'virtual:settings-panels', entry: 'src/renderer/features/settings/settings-panels.ts',
    name: 'settings-panels', exportName: 'loadSettingsPanels', attemptParam: 'settings-attempt',
  });
}
