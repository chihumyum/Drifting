import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appVersion: '0.1.0-alpha.1',
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: { updater: { check: mocks.check, download: mocks.download, install: mocks.install, dismiss: vi.fn() } },
}));
vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({
    target: 'desktop',
    appInfo: { version: mocks.appVersion },
    capabilities: { featureStatus: { appUpdater: 'available' } },
  }),
}));
vi.mock('../../lib/persistence-lifecycle', () => ({ flushLocalApplicationPersistence: vi.fn() }));
vi.mock('../../lib/i18n', () => ({
  i18next: { t: (key: string, options?: { version?: string }) => `${key}:${options?.version}` },
}));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

/** A fresh launch of the app at `version`, with module state reset. */
async function launch(version: string) {
  vi.resetModules();
  mocks.appVersion = version;
  const service = await import('./update-service');
  const { installUpdateNotifications } = await import('./update-notifications');
  const { useNotificationStore } = await import('../../store/notification-store');
  return { ...service, installUpdateNotifications, items: () => useNotificationStore.getState().items };
}

beforeEach(() => {
  storage.clear();
  vi.resetAllMocks();
  mocks.check.mockResolvedValue({ version: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1', notes: 'Faster search.', publishedAt: null });
  mocks.download.mockResolvedValue(1024);
});

it('announces a found update once per version and opens Settings › Updates', async () => {
  const app = await launch('0.1.0-alpha.1');
  const stop = app.installUpdateNotifications();
  await app.UpdateService.check({ manual: true });
  await app.UpdateService.check({ manual: true });

  expect(app.items()).toEqual([
    expect.objectContaining({
      id: 'app-update:0.1.0-alpha.2',
      source: 'app-update',
      title: 'notifications.appUpdate.available:0.1.0-alpha.2',
      settingsSection: 'updates',
    }),
  ]);
  stop();
});

it('says once what the relaunched version installed and keeps its notes for Settings', async () => {
  const before = await launch('0.1.0-alpha.1');
  await before.UpdateService.check({ manual: true });
  await before.UpdateService.download();
  await before.UpdateService.install();

  const after = await launch('0.1.0-alpha.2');
  after.installUpdateNotifications()();
  expect(after.items()).toEqual([
    expect.objectContaining({ id: 'app-updated:0.1.0-alpha.2', title: 'notifications.appUpdate.installed:0.1.0-alpha.2', settingsSection: 'updates' }),
  ]);
  expect(after.installedUpdateFor('0.1.0-alpha.2')).toEqual({ version: '0.1.0-alpha.2', notes: 'Faster search.' });

  const later = await launch('0.1.0-alpha.2');
  later.installUpdateNotifications()();
  expect(later.items()).toEqual([]);
  expect(later.installedUpdateFor('0.1.0-alpha.2')?.notes).toBe('Faster search.');
});

it('announces nothing when the install did not replace the running version', async () => {
  const before = await launch('0.1.0-alpha.1');
  await before.UpdateService.check({ manual: true });
  await before.UpdateService.download();
  await before.UpdateService.install();

  const same = await launch('0.1.0-alpha.1');
  same.installUpdateNotifications()();
  expect(same.items().filter((item) => item.id.startsWith('app-updated:'))).toEqual([]);
  expect(same.installedUpdateFor('0.1.0-alpha.1')).toBeNull();
});
