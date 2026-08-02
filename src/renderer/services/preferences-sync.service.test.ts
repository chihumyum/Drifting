import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal('localStorage', memoryStorage);
  return memoryStorage;
});

vi.mock('../lib/axios-config', () => ({
  apiClient: api,
}));

vi.mock('../lib/config', () => ({
  isSyncEnabled: () => true,
}));

import {
  flushPreferencesSync,
  startPreferencesSync,
  stopPreferencesSync,
} from './preferences-sync.service';
import { useSettingsStore } from '../store/settings-store';
import { DEFAULT_ENTITY_LINK_KIND_COLORS } from '../lib/entity-link-appearance';

describe('preferences sync', () => {
  beforeEach(() => {
    stopPreferencesSync();
    storage.clear();
    api.get.mockReset();
    api.post.mockReset();
    useSettingsStore.setState({
      agentToolSearch: 'off',
      agentMaxContext: false,
      entityLinkColorMode: 'contextual',
      entityLinkKindColors: { ...DEFAULT_ENTITY_LINK_KIND_COLORS },
    });
  });

  afterEach(() => {
    stopPreferencesSync();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes and applies the server value during the initial pull', async () => {
    api.get.mockResolvedValue({
      data: {
        entries: [
          {
            key: 'agentToolSearch',
            value: 'on',
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
      },
    });

    await startPreferencesSync();

    expect(useSettingsStore.getState().agentToolSearch).toBe('on');
  });

  it('applies provider before model and restores the Max context preference', async () => {
    api.get.mockResolvedValue({
      data: {
        entries: [
          { key: 'agentModel', value: 'gpt-5.6-terra', updatedAt: '2026-08-02T00:00:00.000Z' },
          { key: 'agentMaxContext', value: true, updatedAt: '2026-08-02T00:00:00.000Z' },
          { key: 'agentProvider', value: 'openai', updatedAt: '2026-08-02T00:00:00.000Z' },
        ],
      },
    });

    await startPreferencesSync();

    expect(useSettingsStore.getState()).toMatchObject({
      agentProvider: 'openai',
      agentModel: 'gpt-5.6-terra',
      agentMaxContext: true,
    });
  });

  it('falls back to the safe product default for a malformed server value', async () => {
    api.get.mockResolvedValue({
      data: {
        entries: [
          {
            key: 'agentToolSearch',
            value: 'legacy-invalid',
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
      },
    });

    await startPreferencesSync();

    expect(useSettingsStore.getState().agentToolSearch).toBe('auto');
  });

  it('pushes local tool-search changes through the synced preference whitelist', async () => {
    api.get.mockResolvedValue({ data: { entries: [] } });
    api.post.mockResolvedValue({
      data: {
        entries: [
          {
            key: 'agentToolSearch',
            value: 'on',
            updatedAt: '2026-07-31T00:00:00.000Z',
          },
        ],
      },
    });
    await startPreferencesSync();

    useSettingsStore.getState().setAgentToolSearch('on');
    await flushPreferencesSync();

    expect(api.post).toHaveBeenCalledWith('/api/preferences', {
      patches: [{ key: 'agentToolSearch', value: 'on' }],
    });
  });

  it('normalizes pulled entity-link appearance preferences', async () => {
    api.get.mockResolvedValue({
      data: {
        entries: [
          {
            key: 'entityLinkColorMode',
            value: 'kind',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
          {
            key: 'entityLinkKindColors',
            value: { element: '#AABBCC', chapter: 'invalid' },
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      },
    });

    await startPreferencesSync();

    expect(useSettingsStore.getState().entityLinkColorMode).toBe('kind');
    expect(useSettingsStore.getState().entityLinkKindColors).toMatchObject({
      element: '#aabbcc',
      chapter: DEFAULT_ENTITY_LINK_KIND_COLORS.chapter,
    });
  });

  it('pushes entity-link mode and per-type colors together', async () => {
    api.get.mockResolvedValue({ data: { entries: [] } });
    api.post.mockResolvedValue({ data: { entries: [] } });
    await startPreferencesSync();

    useSettingsStore.getState().setEntityLinkColorMode('prose');
    useSettingsStore.getState().setEntityLinkKindColor('drift', '#112233');
    await flushPreferencesSync();

    expect(api.post).toHaveBeenCalledWith('/api/preferences', {
      patches: [
        { key: 'entityLinkColorMode', value: 'prose' },
        {
          key: 'entityLinkKindColors',
          value: { ...DEFAULT_ENTITY_LINK_KIND_COLORS, drift: '#112233' },
        },
      ],
    });
  });
});
