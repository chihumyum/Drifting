import { describe, expect, it, vi } from 'vitest';
import { matchesAccelerator } from './shortcuts';

const runtime = vi.hoisted(() => ({ nativePlatform: 'macos' }));
vi.mock('../platform/runtime', () => ({ getPlatformRuntime: () => runtime }));

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '', code: '', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('shifted bracket accelerators', () => {
  it.each([
    ['[', 'BracketLeft', '{'],
    [']', 'BracketRight', '}'],
  ])('matches Mod+Shift+%s with bracket, brace, or physical key events', (key, code, shifted) => {
    for (const event of [
      keyEvent({ key }),
      keyEvent({ key: shifted }),
      keyEvent({ key: 'Unidentified', code }),
    ]) {
      expect(matchesAccelerator(event, `Mod+Shift+${key}`)).toBe(true);
    }
    expect(matchesAccelerator(keyEvent({ key: shifted, code }), `Mod+${key}`)).toBe(false);
    expect(matchesAccelerator(keyEvent({ key, code, shiftKey: false }), `Mod+${key}`)).toBe(true);
  });

  it('requires the exact modifiers and bracket direction', () => {
    for (const overrides of [
      { metaKey: false }, { ctrlKey: true }, { altKey: true }, { shiftKey: false },
      { key: '}', code: 'BracketRight' },
    ]) {
      expect(matchesAccelerator(keyEvent({ key: '{', code: 'BracketLeft', ...overrides }), 'Mod+Shift+['))
        .toBe(false);
    }
  });

  it('continues using Control as Mod on non-Apple desktops', () => {
    runtime.nativePlatform = 'windows';
    try {
      expect(matchesAccelerator(keyEvent({ key: '}', metaKey: false, ctrlKey: true }), 'Mod+Shift+]'))
        .toBe(true);
      expect(matchesAccelerator(keyEvent({ key: '}' }), 'Mod+Shift+]')).toBe(false);
    } finally {
      runtime.nativePlatform = 'macos';
    }
  });
});
