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

describe('entity link highlight preference', () => {
  it('preserves the existing combined treatment for fresh, old and malformed settings', async () => {
    for (const persisted of [undefined, { entityLinkColorMode: 'hover' }, { entityLinkHighlightMode: 'unknown' }, { entityLinkHighlightMode: null }]) {
      expect((await settings(persisted)).store.getState().entityLinkHighlightMode).toBe('both');
    }
  });

  it.each(['band', 'text', 'both'] as const)('persists %s independently of color source and interaction', async (mode) => {
    const { store, values } = await settings({ entityLinkColorMode: 'kind', entityLinkInteractive: false });
    store.getState().setEntityLinkHighlightMode(mode);
    store.getState().setEntityLinkColorMode('prose');
    const restored = (await settings(JSON.parse(values.get('settings-storage')!).state)).store.getState();
    expect(restored.entityLinkHighlightMode).toBe(mode);
    expect(restored.entityLinkInteractive).toBe(false);
    expect(restored.entityLinkColorMode).toBe('prose');
  });
});

describe('entity link band style preference', () => {
  it('keeps the continuous band for fresh, old and malformed settings', async () => {
    for (const persisted of [undefined, { entityLinkHighlightMode: 'band' }, { entityLinkBandStyle: 'unknown' }, { entityLinkBandStyle: null }]) {
      expect((await settings(persisted)).store.getState().entityLinkBandStyle).toBe('wash');
    }
  });

  it.each(['wash', 'dots'] as const)('restores %s after temporarily hiding the band', async (style) => {
    const { store, values } = await settings({ entityLinkColorMode: 'hover', entityLinkHighlightMode: 'both' });
    store.getState().setEntityLinkBandStyle(style);
    store.getState().setEntityLinkHighlightMode('text');
    const restored = (await settings(JSON.parse(values.get('settings-storage')!).state)).store.getState();
    expect(restored.entityLinkBandStyle).toBe(style);
    expect(restored.entityLinkHighlightMode).toBe('text');
    expect(restored.entityLinkColorMode).toBe('hover');
    restored.setEntityLinkHighlightMode('band');
    expect(restored.entityLinkBandStyle).toBe(style);
  });
});

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

describe('desktop interface text preference', () => {
  it('uses a readable default for old settings and rejects unknown sizes', async () => {
    for (const persisted of [undefined, { themeMode: 'dark' }, { interfaceTextSize: 'tiny' }]) {
      expect((await settings(persisted)).store.getState().interfaceTextSize).toBe('standard');
    }
  });

  it.each(['small', 'large'] as const)('restores %s UI text without changing the author typography', async (size) => {
    const { store, values } = await settings({ bodyFontSize: 21, lineHeight: 1.8 });
    store.getState().setInterfaceTextSize(size);
    const persisted = JSON.parse(values.get('settings-storage')!).state;
    const restoredSettings = await settings(persisted);
    const restored = restoredSettings.store.getState();
    expect(restored.interfaceTextSize).toBe(size);
    expect(restored.bodyFontSize).toBe(21);
    expect(restored.lineHeight).toBe(1.8);
    restored.setInterfaceTextSize('standard');
    const afterReset = JSON.parse(restoredSettings.values.get('settings-storage')!).state;
    expect(afterReset.interfaceTextSize).toBe('standard');
    expect(afterReset.bodyFontSize).toBe(21);
  });
});

describe('editor line wrapping preference', () => {
  it('uses stable wrapping for fresh, old and malformed preferences', async () => {
    for (const persisted of [undefined, { bodyFontSize: 21 }, { editorTextWrap: 'balance' }, { editorTextWrap: null }]) {
      expect((await settings(persisted)).store.getState().editorTextWrap).toBe('stable');
    }
  });

  it.each(['stable', 'pretty'] as const)('persists and restores %s without changing other typography', async (mode) => {
    const { store, values } = await settings({ bodyFontSize: 21, maxLineWidth: 900 });
    store.getState().setEditorTextWrap(mode);
    const restored = (await settings(JSON.parse(values.get('settings-storage')!).state)).store.getState();
    expect(restored.editorTextWrap).toBe(mode);
    expect(restored.bodyFontSize).toBe(21);
    expect(restored.maxLineWidth).toBe(900);
  });

  it('restores stable wrapping with the recommended editor style', async () => {
    const { store, values } = await settings({ editorTextWrap: 'pretty', interfaceTextSize: 'large' });
    store.getState().resetEditorStyle();
    const restored = (await settings(JSON.parse(values.get('settings-storage')!).state)).store.getState();
    expect(restored.editorTextWrap).toBe('stable');
    expect(restored.interfaceTextSize).toBe('large');
  });
});
