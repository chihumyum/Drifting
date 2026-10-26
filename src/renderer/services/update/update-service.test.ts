import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
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
    capabilities: { featureStatus: { appUpdater: 'available' } },
  }),
}));
vi.mock('../../lib/persistence-lifecycle', () => ({
  flushLocalApplicationPersistence: mocks.flush,
}));

const update = {
  version: '0.1.0-alpha.2',
  currentVersion: '0.1.0-alpha.1',
  notes: null,
  publishedAt: null,
};

async function readyService() {
  vi.resetModules();
  const module = await import('./update-service');
  await module.UpdateService.check({ manual: true });
  await module.UpdateService.download();
  expect(module.UpdateService.getState().phase).toBe('ready');
  return module;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.order.length = 0;
  mocks.check.mockResolvedValue(update);
  mocks.download.mockResolvedValue(1024);
  mocks.flush.mockImplementation(async () => {
    mocks.order.push('flush');
  });
  mocks.install.mockImplementation(async () => {
    mocks.order.push('install');
  });
});

it('saves every local write before the native install and relaunch', async () => {
  const { UpdateService } = await readyService();
  const phases: string[] = [];
  UpdateService.subscribe((state) => phases.push(state.phase));

  await UpdateService.install();

  expect(mocks.order).toEqual(['flush', 'install']);
  expect(phases).toContain('installing');
  expect(UpdateService.getState().error).toBeNull();
});

it('keeps the verified update ready and installs nothing when saving fails', async () => {
  const { UpdateService, UPDATE_LOCAL_SAVE_FAILED } = await readyService();
  mocks.flush.mockRejectedValueOnce(new AggregateError([new Error('disk full')]));

  await expect(UpdateService.install()).rejects.toBeInstanceOf(AggregateError);

  expect(mocks.install).not.toHaveBeenCalled();
  expect(UpdateService.getState()).toMatchObject({
    phase: 'ready',
    update,
    error: UPDATE_LOCAL_SAVE_FAILED,
  });

  await UpdateService.install();
  expect(mocks.order).toEqual(['flush', 'install']);
});

it('reports a native install failure after a successful save', async () => {
  const { UpdateService } = await readyService();
  mocks.install.mockRejectedValueOnce(new Error('bundle is read-only'));

  await expect(UpdateService.install()).rejects.toThrow('bundle is read-only');

  expect(mocks.flush).toHaveBeenCalledOnce();
  expect(UpdateService.getState()).toMatchObject({
    phase: 'error',
    error: 'bundle is read-only',
  });
});
