import { describe, expect, it } from 'vitest';

import { readPersistedThemeMode, resolveColorScheme } from './initial-theme';

describe('initial theme bootstrap', () => {
  it.each(['light', 'dark', 'system'] as const)('restores persisted %s mode', (themeMode) => {
    expect(readPersistedThemeMode(JSON.stringify({ state: { themeMode }, version: 29 }))).toBe(
      themeMode,
    );
  });

  it.each([null, '', 'not-json', '{"state":{"themeMode":"unsupported"}}']) (
    'uses the public light default for invalid persisted input %s',
    (raw) => {
      expect(readPersistedThemeMode(raw)).toBe('light');
    },
  );

  it('resolves system mode from the native color-scheme media query', () => {
    expect(resolveColorScheme('system', true)).toBe('dark');
    expect(resolveColorScheme('system', false)).toBe('light');
    expect(resolveColorScheme('dark', false)).toBe('dark');
  });
});
