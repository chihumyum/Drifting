import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  status: 'offline',
  refresh: vi.fn(),
  discover: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock('../../lib/config', () => ({ canUseHostedService: () => true }));
vi.mock('../../lib/db', () => ({ getDb: () => ({}), getDbIfInitialized: () => ({}) }));
vi.mock('../../lib/events', () => ({ events: { on() {}, off() {} } }));
vi.mock('../../lib/hosted-session-binding', () => ({
  getHostedSessionBinding: () => (state.status === 'connected' ? { accountSubject: 'test' } : null),
}));
vi.mock('../../platform', () => ({ platform: { lifecycle: { onReadyOrResume: () => () => {} } } }));
vi.mock('../../store/auth', () => ({
  useAuthStore: {
    getState: () => ({ hostedStatus: state.status, refreshHostedSession: state.refresh }),
  },
}));
vi.mock('./connect', () => ({ discoverHostedProjects: state.discover }));
import { installHostedDiscoveryRuntime } from './runtime';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.listeners.clear();
});
describe('Hosted service recovery after offline startup', () => {
  it('revalidates on a timer or focus without a browser online event, then resumes discovery', async () => {
    vi.useFakeTimers();
    state.status = 'offline';
    state.refresh.mockImplementation(async () => {
      state.status = 'connected';
    });
    state.discover.mockResolvedValue([]);
    vi.stubGlobal('addEventListener', (name: string, listener: () => void) =>
      state.listeners.set(name, listener),
    );
    vi.stubGlobal('removeEventListener', (name: string) => state.listeners.delete(name));
    const stop = installHostedDiscoveryRuntime();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.discover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    state.status = 'offline';
    state.listeners.get('focus')?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.refresh).toHaveBeenCalledTimes(2);
    state.status = 'needs-reauth';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.refresh).toHaveBeenCalledTimes(2);
    stop();
    expect(state.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
