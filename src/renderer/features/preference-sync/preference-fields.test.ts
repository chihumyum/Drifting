import { afterEach, describe, expect, it, vi } from 'vitest';

async function fields() {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  const module = await import('./preference-fields');
  const { useSettingsStore } = await import('../../store/settings-store');
  const { useShortcutsStore } = await import('../../store/shortcuts-store');
  return { ...module, settings: useSettingsStore, shortcuts: useShortcutsStore };
}

afterEach(() => vi.unstubAllGlobals());

describe('synced preference fields', () => {
  it('leaves device-bound settings out', async () => {
    const { PREFERENCE_KEYS } = await fields();
    for (const key of ['editorFontSource', 'editorSystemFontFamily', 'interfaceTextSize', 'editorTextWrap',
      'agentProvider', 'agentModel', 'agentEffort', 'agentThinking',
      'agentOnboardingStep', 'lastAgentConvByProject', 'sendCrashLogs'])
      expect(PREFERENCE_KEYS).not.toContain(key);
  });

  it('applies valid values through the editor ranges and refuses unknown ones', async () => {
    const { applyPreference, readPreference, settings } = await fields();
    expect(applyPreference('themeMode', 'dark')).toBe(true);
    expect(applyPreference('themeMode', 'sepia')).toBe(false);
    expect(settings.getState().themeMode).toBe('dark');
    expect(applyPreference('bodyFontSize', 40)).toBe(true);
    expect(readPreference('bodyFontSize')).toBe(28);
    expect(applyPreference('bodyFontSize', '19')).toBe(false);
    expect(applyPreference('accentColor', null)).toBe(true);
    expect(applyPreference('accentColor', '#ABCDEF')).toBe(false);
    expect(applyPreference('accentColor', '#abcdef')).toBe(true);
    expect(applyPreference('caretColor', 'red')).toBe(false);
    expect(applyPreference('entityLinkColorMode', 'rainbow')).toBe(false);
    expect(applyPreference('entityLinkColorMode', 'kind')).toBe(true);
    expect(applyPreference('uiLocale', 'fr')).toBe(true);
    expect(applyPreference('uiLocale', 'xx')).toBe(false);
    expect(applyPreference('agentTurnIterationLimit', null)).toBe(true);
    expect(settings.getState().agentTurnIterationLimit).toBeNull();
    expect(applyPreference('editorFontSource', 'system-mono')).toBe(false);
  });

  it('keeps shortcut actions this version knows and ignores the rest', async () => {
    const { applyPreference, shortcuts } = await fields();
    const before = shortcuts.getState().bindings;
    expect(applyPreference('shortcutBindings', { globalSearch: 'CmdOrCtrl+Shift+K', futureAction: 'CmdOrCtrl+J', goBack: 3 })).toBe(true);
    const after = shortcuts.getState().bindings;
    expect(after.globalSearch).toBe('CmdOrCtrl+Shift+K');
    expect(after.goBack).toBe(before.goBack);
    expect(after).not.toHaveProperty('futureAction');
  });
});
