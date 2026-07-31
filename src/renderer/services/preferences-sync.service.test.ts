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

describe('General Agent tool-search preference sync', () => {
  beforeEach(() => {
    stopPreferencesSync();
    storage.clear();
    api.get.mockReset();
    api.post.mockReset();
    useSettingsStore.setState({ agentToolSearch: 'off' });
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
});
