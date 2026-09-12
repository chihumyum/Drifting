declare module 'virtual:settings-panels' {
  export function loadSettingsPanels(): Promise<typeof import('./features/settings/settings-panels')>;
}
