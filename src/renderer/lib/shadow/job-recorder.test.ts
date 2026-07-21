import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stopShadowJob } from './job-recorder';

const mocks = vi.hoisted(() => ({
  cancelRuntimeJob: vi.fn(),
  enqueueRuntimeJob: vi.fn(),
  emit: vi.fn(),
  repoUpdate: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('./runtime', () => ({
  cancelShadowJob: mocks.cancelRuntimeJob,
  enqueueShadowJob: mocks.enqueueRuntimeJob,
}));

vi.mock('../events', () => ({ events: { emit: mocks.emit } }));

vi.mock('../../sqlite-repo/shadow-job-repo', () => ({
  createShadowJobRepository: () => ({
    update: mocks.repoUpdate,
  }),
}));

vi.mock('../../store/data-store', () => ({
  useDataStore: { getState: mocks.getState },
}));

describe('stopShadowJob commit boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getState.mockReturnValue({ shadowJobs: [] });
  });

  it('does not publish or persist stopped after the runtime rejects a late cancel', async () => {
    mocks.cancelRuntimeJob.mockReturnValue(false);

    await expect(stopShadowJob('chapter-1', 'project-1')).resolves.toBe(false);

    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.repoUpdate).not.toHaveBeenCalled();
  });
});
