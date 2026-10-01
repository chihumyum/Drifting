import { afterEach, describe, expect, it, vi } from 'vitest';

async function settings(persisted?: Record<string, unknown>) {
  vi.resetModules();
  const values = new Map<string, string>();
  if (persisted) values.set('settings-storage', JSON.stringify({ state: persisted, version: 30 }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  const { useSettingsStore } = await import('./settings-store');
  return { store: useSettingsStore, values };
}

afterEach(() => vi.unstubAllGlobals());

describe('Agent reveal animation preference persistence', () => {
  it('keeps animation enabled for a fresh or pre-preference installation', async () => {
    expect((await settings()).store.getState().agentEditRevealAnimation).toBe(true);
    expect((await settings({ themeMode: 'dark' })).store.getState().agentEditRevealAnimation).toBe(true);
  });

  it('persists an explicit off choice and restores it without changing approval mode', async () => {
    const { store, values } = await settings({ agentEditMode: 'approve' });
    store.getState().setAgentEditRevealAnimation(false);
    const persisted = JSON.parse(values.get('settings-storage')!).state;
    expect(persisted.agentEditRevealAnimation).toBe(false);
    const restored = await settings(persisted);
    expect(restored.store.getState().agentEditRevealAnimation).toBe(false);
    expect(restored.store.getState().agentEditMode).toBe('approve');
  });
});
