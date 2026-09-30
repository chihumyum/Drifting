declare module 'virtual:settings-panels' {
  export function loadSettingsPanels(): Promise<typeof import('./features/settings/settings-panels')>;
}
declare module 'virtual:settings-preference' {
  export function loadPanels(): Promise<typeof import('./features/settings/panels/PreferenceSettingsPanels')>;
}
declare module 'virtual:settings-intelligence' {
  export function loadPanels(): Promise<typeof import('./features/settings/panels/IntelligenceSettingsPanels')>;
}
declare module 'virtual:settings-agent' {
  export function loadPanels(): Promise<typeof import('./features/settings/panels/AgentSettingsPanel')>;
}
declare module 'virtual:settings-control' {
  export function loadPanels(): Promise<typeof import('./features/settings/panels/AccountControlSettingsPanels')>;
}
