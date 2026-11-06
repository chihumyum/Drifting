import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});

import { useSettingsStore } from './settings-store';

// Typewriter scrolling is immersive writing's alone (docs/editor/immersive-writing.md).
describe('retired typewriter switch', () => {
  it('drops a stored typewriter switch on migration and keeps the typing line position', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const migrated = (await migrate({ typewriterMode: true, typewriterPosition: 35 }, 35)) as Record<string, unknown>;
    expect(migrated).not.toHaveProperty('typewriterMode');
    expect(migrated.typewriterPosition).toBe(35);
  });
});
