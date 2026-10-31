import { beforeEach, describe, expect, it, vi } from 'vitest';

const delta = vi.hoisted(() => ({ hasCheckinDelta: vi.fn(async (..._args: unknown[]) => false) }));
vi.mock('../lib/agent/checkin/checkin-delta', () => delta);
const runner = vi.hoisted(() => ({ runProjectCheckin: vi.fn(async (..._args: unknown[]) => ({ cards: [] })) }));
vi.mock('../lib/agent/checkin/checkin-runner', () => runner);
const readiness = vi.hoisted(() => ({ ready: true, canAgentProviderRun: vi.fn(async (..._args: unknown[]) => true) }));
vi.mock('../lib/agent/agent-provider-readiness', () => ({
  canAgentProviderRun: (...args: unknown[]) => readiness.canAgentProviderRun(...args),
}));
vi.mock('../store/agent-chat-store', () => ({ useAgentChatStore: { getState: vi.fn() } }));

const { useProjectOrganizeStore } = await import('../store/project-organize-store');
const { readProjectCheckin, useProjectCheckinStore } = await import('../store/project-checkin-store');
const { maybeRunProjectCheckin } = await import('./useProjectCheckin');

const MISSING_KEY = 'General Agent needs a configured DeepSeek API key.';

beforeEach(() => {
  vi.clearAllMocks();
  readiness.canAgentProviderRun.mockImplementation(async () => readiness.ready);
  readiness.ready = true;
  delta.hasCheckinDelta.mockImplementation(async () => false);
  useProjectOrganizeStore.setState({ enabled: true, projects: {}, active: {} });
  useProjectCheckinStore.setState({ enabled: true, projects: {}, running: {} });
});

describe('check-in after organizing', () => {
  it('waits while an organize pass holds the project, unless forced', async () => {
    useProjectOrganizeStore.getState().setActive('p1', true);
    await maybeRunProjectCheckin('p1', '雾港纪事');
    expect(delta.hasCheckinDelta).not.toHaveBeenCalled();
    await maybeRunProjectCheckin('p1', '雾港纪事', { force: true });
    expect(delta.hasCheckinDelta).toHaveBeenCalled();
  });
});

describe('check-in without a model', () => {
  it('does not run, record an attempt or fail while the selected provider cannot run', async () => {
    readiness.ready = false;
    delta.hasCheckinDelta.mockImplementation(async () => true);

    await maybeRunProjectCheckin('p2', '潮汐灯塔');

    expect(runner.runProjectCheckin).not.toHaveBeenCalled();
    expect(readProjectCheckin('p2')).toMatchObject({ error: null, lastAttemptAt: null });
  });

  it('drops a missing-key failure left by an earlier check-in', async () => {
    readiness.ready = false;
    useProjectCheckinStore.getState().failCheckin('p3', MISSING_KEY);

    await maybeRunProjectCheckin('p3', '潮汐灯塔');

    expect(readProjectCheckin('p3').error).toBeNull();
  });

  it('keeps other failures for the author to see', async () => {
    readiness.ready = false;
    useProjectCheckinStore.getState().failCheckin('p4', 'The provider timed out.');

    await maybeRunProjectCheckin('p4', '潮汐灯塔');

    expect(readProjectCheckin('p4').error).toBe('The provider timed out.');
  });

  it('checks in once a model is connected', async () => {
    readiness.ready = true;
    delta.hasCheckinDelta.mockImplementation(async () => true);

    await maybeRunProjectCheckin('p5', '潮汐灯塔');

    expect(runner.runProjectCheckin).toHaveBeenCalledTimes(1);
    expect(readProjectCheckin('p5').lastAttemptAt).not.toBeNull();
  });

  it('still runs "Check in now" so the author learns why it cannot', async () => {
    readiness.ready = false;
    delta.hasCheckinDelta.mockImplementation(async () => true);
    runner.runProjectCheckin.mockRejectedValueOnce(new Error(MISSING_KEY));

    await maybeRunProjectCheckin('p6', '潮汐灯塔', { force: true });

    expect(runner.runProjectCheckin).toHaveBeenCalledTimes(1);
    expect(readProjectCheckin('p6').error).toBe(MISSING_KEY);
  });
});
