import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_STORAGE_VERSION,
  migrateAccentColor,
} from '../store/settings-store';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('user accent color preference acceptance', () => {
  it('models, migrates, and persists an explicit nullable accent preference locally', () => {
    const settings = source('src/renderer/store/settings-store.ts');

    expect(settings).toContain('accentColor: string | null;');
    expect(settings).toContain('setAccentColor: (color: string | null) => void;');
    expect(settings).toContain('accentColor: null,');
    expect(settings).toContain('merged.accentColor = normalizeAccentColor(merged.accentColor);');
    expect(settings).toContain("name: 'settings-storage'");
    expect(settings).toContain('storage: createJSONStorage(() => localStorage)');

    // This feature owns the v29 migration boundary, not the mutable current
    // version of the aggregate settings store.
    expect(SETTINGS_STORAGE_VERSION).toBeGreaterThanOrEqual(29);
    expect(migrateAccentColor('#ABCDEF', 28)).toBeNull();
    expect(migrateAccentColor('#ABCDEF', 29)).toBe('#abcdef');
    expect(migrateAccentColor('invalid', 29)).toBeNull();
  });

  it('wires one shared settings control to the renderer-owned accent tokens', () => {
    const panel = source('src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx');
    const effects = source('src/renderer/app/effects/AppEffects.tsx');
    const theme = source('src/renderer/lib/theme.ts');

    expect(panel).toContain("t('settings.appearance.accent_color')");
    expect(panel).toContain('type="color"');
    expect(panel).toContain('setAccentColor(event.target.value)');
    expect(panel).toContain('setAccentColor(null)');
    expect(effects).toContain('applyAccentColor(accentColor);');
    expect(theme).toContain("root.style.setProperty('--accent', accent);");
    expect(theme).toContain("root.style.setProperty('--accent-foreground'");
    expect(theme).toContain("root.style.setProperty('--ring', accent);");
  });

  it('keeps the editor caret on its independent preference and CSS variable', () => {
    const panel = source('src/renderer/features/settings/panels/PreferenceSettingsPanels.tsx');
    const editorPreferences = source('src/renderer/lib/editor-preferences.ts');

    expect(panel).toContain('setCaretColor(event.target.value)');
    expect(editorPreferences).toContain(
      "root.style.setProperty('--editor-caret-color', prefs.caretColor);",
    );
    expect(editorPreferences).not.toContain('--accent');
  });
});
