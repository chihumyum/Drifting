import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** An in-memory account preferences v1 service with the real merge rule. */
const service = vi.hoisted(() => {
  const state = {
    bag: {} as Record<string, { value: unknown; changedAt: string }>,
    puts: [] as { key: string; value: unknown; changedAt: string }[][],
    status: 200,
    authority: { mode: 'hosted', status: 'cloud-ready' },
    authorityListeners: new Set<() => void>(),
  };
  const fetch = async (_url: string, init: { method?: string; body?: string }) => {
    if (state.status !== 200) return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: state.status });
    if (init.method === 'PUT') {
      const { entries } = JSON.parse(init.body!) as { entries: { key: string; value: unknown; changedAt: string }[] };
      state.puts.push(entries);
      for (const entry of entries)
        if (!state.bag[entry.key] || entry.changedAt > state.bag[entry.key].changedAt)
          state.bag[entry.key] = { value: entry.value, changedAt: entry.changedAt };
    }
    return new Response(JSON.stringify({ preferences: state.bag }), { status: 200 });
  };
  return { state, fetch };
});

vi.mock('../../lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>();
  return {
    ...actual,
    APP_CONFIG: { ...actual.APP_CONFIG, LOCAL_ONLY_MODE: false, API_BASE_URL: 'http://service.test' },
    canUseHostedService: () => true,
  };
});
vi.mock('../../lib/auth-client', () => ({ hostedAccountFetch: service.fetch }));
vi.mock('../../lib/hosted-session-binding', () => ({
  getHostedSessionBinding: () => ({ accountSubject: 'author', token: 'synthetic-token' }),
}));
vi.mock('../../sync/product-authority-store', () => ({
  productSyncAuthorityStore: {
    getSnapshot: () => service.state.authority,
    subscribe(listener: () => void) {
      service.state.authorityListeners.add(listener);
      return () => service.state.authorityListeners.delete(listener);
    },
  },
}));
vi.mock('../../store/auth', () => ({ useAuthStore: { subscribe: () => () => undefined } }));
vi.mock('../../platform', () => ({ platform: { lifecycle: { onReadyOrResume: () => () => undefined } } }));

async function runtime() {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  const { useSettingsStore } = await import('../../store/settings-store');
  const { events } = await import('../../lib/events');
  const { installPreferenceSyncRuntime } = await import('./preference-sync-runtime');
  const stop = installPreferenceSyncRuntime();
  const ledger = () => JSON.parse(values.get('preference-sync-v1') ?? 'null') as {
    entries: Record<string, { changedAt: string; pending: boolean }>;
  } | null;
  return { stop, settings: useSettingsStore, events, ledger };
}

beforeEach(() => {
  service.state.bag = {};
  service.state.puts = [];
  service.state.status = 200;
  service.state.authority = { mode: 'hosted', status: 'cloud-ready' };
  service.state.authorityListeners.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('preference sync runtime', () => {
  it('fills the account with this device settings and keeps device-bound ones out', async () => {
    const { stop } = await runtime();
    await vi.waitFor(() => expect(service.state.puts.length).toBe(1));
    expect(Object.keys(service.state.bag).sort()).toEqual([
      'accentColor', 'agentEditRevealAnimation', 'agentTurnIterationLimit', 'autoElementLinkEnabled', 'autoImmersiveWriting',
      'bodyFontSize', 'caretColor', 'editorIndentStep', 'entityLinkBandStyle', 'entityLinkColorMode',
      'entityLinkHighlightMode', 'entityLinkKindColors', 'lineHeight', 'maxLineWidth', 'paragraphIndent',
      'paragraphSpacing', 'shortcutBindings', 'themeMode', 'typewriterMode', 'typewriterPosition', 'uiLocale',
    ]);
    stop();
  });

  it('sends a change made here once, after the edit settles', async () => {
    const { stop, settings, ledger } = await runtime();
    await vi.waitFor(() => expect(service.state.puts.length).toBe(1));
    settings.getState().setBodyFontSize(19);
    settings.getState().setBodyFontSize(20);
    expect(ledger()?.entries.bodyFontSize.pending).toBe(true);
    await vi.waitFor(() => expect(service.state.bag.bodyFontSize.value).toBe(20), { timeout: 3000 });
    expect(service.state.puts[service.state.puts.length - 1]).toEqual([expect.objectContaining({ key: 'bodyFontSize', value: 20 })]);
    expect(ledger()?.entries.bodyFontSize.pending).toBe(false);
    stop();
  });

  it('applies a change from another device without counting it as one made here', async () => {
    const { stop, settings, events, ledger } = await runtime();
    await vi.waitFor(() => expect(service.state.puts.length).toBe(1));
    service.state.bag.themeMode = { value: 'dark', changedAt: '2026-11-02T07:00:00.000Z' };
    service.state.bag.caretColor = { value: '#112233', changedAt: '2026-11-02T07:00:00.000Z' };
    events.emit('sync:authority-changed');
    await vi.waitFor(() => expect(settings.getState().themeMode).toBe('dark'));
    expect(settings.getState().caretColor).toBe('#112233');
    expect(ledger()?.entries.themeMode).toEqual({ changedAt: '2026-11-02T07:00:00.000Z', pending: false });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(service.state.puts.length).toBe(1);
    stop();
  });

  it('records changes but sends nothing while sync is paused, and catches up on resume', async () => {
    service.state.authority = { mode: 'hosted', status: 'cloud-paused' };
    const { stop, settings } = await runtime();
    settings.getState().setThemeMode('system');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(service.state.puts.length).toBe(0);
    // The authority event fires before its snapshot is re-read; the snapshot change alone resumes.
    service.state.authority = { mode: 'hosted', status: 'cloud-ready' };
    for (const listener of service.state.authorityListeners) listener();
    await vi.waitFor(() => expect(service.state.bag.themeMode?.value).toBe('system'));
    stop();
  });

  it('treats a service without preferences as unsupported instead of failing', async () => {
    service.state.status = 404;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stop, settings } = await runtime();
    await new Promise((resolve) => setTimeout(resolve, 50));
    settings.getState().setThemeMode('dark');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(warn).not.toHaveBeenCalled();
    expect(service.state.puts.length).toBe(0);
    warn.mockRestore();
    stop();
  });
});
