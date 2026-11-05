import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  appVersion: '0.1.0-alpha.1',
  flush: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: {
    updater: {
      check: mocks.check,
      download: mocks.download,
      install: mocks.install,
      dismiss: mocks.dismiss,
    },
  },
}));
vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({
    target: 'desktop',
    appInfo: { version: mocks.appVersion },
    capabilities: { featureStatus: { appUpdater: 'available' } },
  }),
}));
vi.mock('../../lib/persistence-lifecycle', () => ({
  flushLocalApplicationPersistence: mocks.flush,
}));

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

const update = {
  version: '0.1.0-alpha.2',
  currentVersion: '0.1.0-alpha.1',
  notes: null,
  publishedAt: null,
};

const HOUR = 60 * 60 * 1_000;
let now = 1_800_000_000_000;

/** A fresh launch: module state reset, preferences kept. */
async function launch() {
  vi.resetModules();
  return import('./update-service');
}

async function offeredService() {
  const module = await launch();
  await module.UpdateService.check({ manual: true });
  expect(module.UpdateService.getState().phase).toBe('available');
  return module;
}

beforeEach(() => {
  vi.resetAllMocks();
  storage.clear();
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mocks.order.length = 0;
  mocks.appVersion = '0.1.0-alpha.1';
  mocks.check.mockResolvedValue(update);
  mocks.download.mockImplementation(async () => {
    mocks.order.push('download');
    return 1024;
  });
  mocks.flush.mockImplementation(async () => {
    mocks.order.push('flush');
  });
  mocks.install.mockImplementation(async () => {
    mocks.order.push('install');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('installs a found update in one click: download, verify, save every local write, install', async () => {
  const { UpdateService } = await offeredService();
  const phases: string[] = [];
  UpdateService.subscribe((state) => phases.push(state.phase));

  await UpdateService.install();

  expect(mocks.order).toEqual(['download', 'flush', 'install']);
  expect(phases).toEqual(['available', 'downloading', 'ready', 'installing']);
  expect(UpdateService.getState().error).toBeNull();
});

it('keeps the verified download and installs nothing when saving fails; a retry does not download again', async () => {
  const { UpdateService, UPDATE_LOCAL_SAVE_FAILED } = await offeredService();
  mocks.flush.mockRejectedValueOnce(new AggregateError([new Error('disk full')]));

  await expect(UpdateService.install()).rejects.toBeInstanceOf(AggregateError);

  expect(mocks.install).not.toHaveBeenCalled();
  expect(UpdateService.getState()).toMatchObject({
    phase: 'ready',
    update,
    error: UPDATE_LOCAL_SAVE_FAILED,
  });

  await UpdateService.install();
  expect(mocks.order).toEqual(['download', 'flush', 'install']);
});

it('reports a native install failure after a successful save; a retry installs the kept bytes', async () => {
  const { UpdateService } = await offeredService();
  mocks.install.mockRejectedValueOnce(new Error('bundle is read-only'));

  await expect(UpdateService.install()).rejects.toThrow('bundle is read-only');

  expect(mocks.flush).toHaveBeenCalledOnce();
  expect(UpdateService.getState()).toMatchObject({
    phase: 'error',
    update,
    error: 'bundle is read-only',
  });

  await UpdateService.install();
  expect(mocks.download).toHaveBeenCalledOnce();
  expect(mocks.install).toHaveBeenCalledTimes(2);
});

it('leaves the running version alone when the download fails, and downloads again on retry', async () => {
  const { UpdateService } = await offeredService();
  mocks.download.mockRejectedValueOnce(new Error('could not download or verify the update'));

  await expect(UpdateService.install()).rejects.toThrow('could not download');

  expect(mocks.flush).not.toHaveBeenCalled();
  expect(mocks.install).not.toHaveBeenCalled();
  expect(UpdateService.getState()).toMatchObject({ phase: 'error', update });

  await UpdateService.install();
  expect(mocks.order).toEqual(['download', 'flush', 'install']);
});

it('says a failed check plainly instead of passing on the updater\'s words', async () => {
  const { UpdateService, UPDATE_CHECK_FAILED } = await launch();
  mocks.check.mockRejectedValueOnce(
    new Error('could not check for an update: Could not fetch a valid release JSON from the remote'),
  );

  await UpdateService.check({ manual: true });

  expect(UpdateService.getState()).toMatchObject({ phase: 'error', update: null, error: UPDATE_CHECK_FAILED });
});

it('checks automatically at most every 3 hours', async () => {
  mocks.check.mockResolvedValue(null);
  const { UpdateService, AUTO_CHECK_INTERVAL_MS } = await launch();
  expect(AUTO_CHECK_INTERVAL_MS).toBe(3 * HOUR);

  await UpdateService.check();
  now += 3 * HOUR - 1;
  await UpdateService.check();
  expect(mocks.check).toHaveBeenCalledOnce();

  now += 1;
  await UpdateService.check();
  expect(mocks.check).toHaveBeenCalledTimes(2);

  const relaunched = await launch();
  await relaunched.UpdateService.check();
  expect(mocks.check).toHaveBeenCalledTimes(2);
});

it('does not check automatically while an update is downloading or downloaded', async () => {
  const { UpdateService } = await offeredService();
  let finishDownload!: (size: number) => void;
  mocks.download.mockImplementationOnce(() => new Promise<number>((resolve) => { finishDownload = resolve; }));
  mocks.flush.mockRejectedValueOnce(new Error('disk full'));

  const installing = UpdateService.install();
  now += 4 * HOUR;
  await UpdateService.check();
  expect(UpdateService.getState().phase).toBe('downloading');
  finishDownload(1024);
  await expect(installing).rejects.toThrow('disk full');
  expect(UpdateService.getState().phase).toBe('ready');

  now += 4 * HOUR;
  await UpdateService.check();
  expect(mocks.check).toHaveBeenCalledOnce();
  expect(UpdateService.getState().phase).toBe('ready');
});

it('keeps offering a found update while an automatic check refreshes it', async () => {
  const { UpdateService } = await offeredService();
  const phases: string[] = [];
  UpdateService.subscribe((state) => phases.push(state.phase));

  now += 3 * HOUR;
  mocks.check.mockRejectedValueOnce(new Error('offline'));
  await UpdateService.check();
  now += 3 * HOUR;
  mocks.check.mockResolvedValueOnce({ ...update, version: '0.1.0-alpha.3' });
  await UpdateService.check();

  expect(phases.every((phase) => phase === 'available')).toBe(true);
  expect(UpdateService.getState().update?.version).toBe('0.1.0-alpha.3');
});

it('does not look up an update found in this launch again before the interval', async () => {
  const { UpdateService } = await launch();
  await UpdateService.check();
  now += HOUR;
  await UpdateService.check();
  expect(mocks.check).toHaveBeenCalledOnce();
});

it('looks up an update found before a relaunch at once, and stops once it is installed', async () => {
  const first = await launch();
  await first.UpdateService.check();
  expect(mocks.check).toHaveBeenCalledOnce();

  now += HOUR;
  const relaunched = await launch();
  await relaunched.UpdateService.check();
  expect(mocks.check).toHaveBeenCalledTimes(2);
  expect(relaunched.UpdateService.getState().phase).toBe('available');
  // Once per launch: the ordinary interval applies afterwards.
  await relaunched.UpdateService.check();
  expect(mocks.check).toHaveBeenCalledTimes(2);

  mocks.appVersion = update.version;
  const updated = await launch();
  await updated.UpdateService.check();
  expect(mocks.check).toHaveBeenCalledTimes(2);
});
