import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** An in-memory account notices v1 service behind the Hosted account fetch. */
const service = vi.hoisted(() => {
  const state = {
    binding: { accountSubject: 'author', token: 'synthetic-token' } as { accountSubject: string; token: string } | null,
    notices: [] as { id: string; seq: number; content: Record<string, { title: string; body: string }>; link?: string }[],
    readThrough: 0,
    status: 200,
    requests: [] as { method: string; path: string; body: unknown; authorization: string | undefined }[],
    authListeners: new Set<(state: unknown, previous: unknown) => void>(),
  };
  const fetch = async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) as { through: number } : undefined;
    state.requests.push({ method: init.method ?? 'GET', path, body, authorization: init.headers?.Authorization });
    if (state.status !== 200) return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: state.status });
    if (path.endsWith('/read')) {
      state.readThrough = Math.max(state.readThrough, Math.min(body!.through, state.notices.length));
      return new Response(JSON.stringify({ readThrough: state.readThrough }), { status: 200 });
    }
    return new Response(JSON.stringify({
      notices: state.notices.map((notice) => ({ personal: false, link: null, publishedAt: '2026-11-13T07:00:00.000Z', ...notice })),
      readThrough: state.readThrough,
      refreshAfterSeconds: 60,
    }), { status: 200 });
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
vi.mock('../../lib/hosted-session-binding', () => ({ getHostedSessionBinding: () => service.state.binding }));
vi.mock('../../store/auth', () => ({
  useAuthStore: {
    subscribe(listener: (state: unknown, previous: unknown) => void) {
      service.state.authListeners.add(listener);
      return () => service.state.authListeners.delete(listener);
    },
  },
}));
vi.mock('../../platform', () => ({ platform: { lifecycle: { onReadyOrResume: () => () => undefined } } }));

const zh = (title: string) => ({ zh: { title, body: `${title}的正文。` } });
const reads = () => service.state.requests.filter((request) => request.method === 'GET').length;
const lastRequest = () => service.state.requests[service.state.requests.length - 1]!;
const settle = () => vi.advanceTimersByTimeAsync(0);

async function runtime() {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  const { useNotificationStore } = await import('../../store/notification-store');
  const { installNoticeRuntime } = await import('./notice-runtime');
  const stop = installNoticeRuntime();
  await settle();
  const titles = () => useNotificationStore.getState().items.map((item) => item.title);
  return { stop, center: useNotificationStore, titles, stored: () => values.get('account-notices-dismissed-v1') };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-11-13T08:00:00.000Z') });
  service.state.binding = { accountSubject: 'author', token: 'synthetic-token' };
  service.state.notices = [];
  service.state.readThrough = 0;
  service.state.status = 200;
  service.state.requests = [];
  service.state.authListeners.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('notice runtime', () => {
  it('reads with the account session at start and again each minute', async () => {
    service.state.notices = [{ id: 'n1', seq: 1, content: zh('今晚维护') }];
    const app = await runtime();
    expect(app.titles()).toEqual(['今晚维护']);
    expect(service.state.requests).toEqual([
      { method: 'GET', path: '/api/account/v1/notices', body: undefined, authorization: 'Bearer synthetic-token' },
    ]);

    service.state.notices.push({ id: 'n2', seq: 2, content: zh('恢复了') });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads()).toBe(2);
    expect(app.titles()).toEqual(['恢复了', '今晚维护']);
    app.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(2);
  });

  it('tells the service once the center has been opened, and remembers a removed notice', async () => {
    service.state.notices = [{ id: 'n1', seq: 1, content: zh('一') }, { id: 'n2', seq: 2, content: zh('二') }];
    const app = await runtime();
    app.center.getState().toggleCenter();
    await settle();
    expect(lastRequest()).toEqual(
      { method: 'POST', path: '/api/account/v1/notices/read', body: { through: 2 }, authorization: 'Bearer synthetic-token' },
    );
    app.center.getState().remove('notice:n1');
    await settle();
    expect(JSON.parse(app.stored()!)).toEqual({ author: ['n1'] });
    await vi.advanceTimersByTimeAsync(75_000);
    expect(app.titles()).toEqual(['二']);
    expect(service.state.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    app.stop();
  });

  it('takes the notices away when the author signs out, and shows the next account its own', async () => {
    service.state.notices = [{ id: 'n1', seq: 1, content: zh('一') }];
    const app = await runtime();
    expect(app.titles()).toEqual(['一']);

    service.state.binding = null;
    for (const listener of service.state.authListeners) listener({ hostedStatus: 'signed-out' }, { hostedStatus: 'connected' });
    await settle();
    expect(app.titles()).toEqual([]);
    expect(app.stored()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads()).toBe(1);

    service.state.binding = { accountSubject: 'reader', token: 'other-token' };
    service.state.notices = [{ id: 'n2', seq: 2, content: zh('二') }];
    for (const listener of service.state.authListeners) listener({ hostedStatus: 'connected' }, { hostedStatus: 'signed-out' });
    await settle();
    expect(app.titles()).toEqual(['二']);
    expect(lastRequest().authorization).toBe('Bearer other-token');
    app.stop();
  });

  it('leaves a service without notices alone for an hour', async () => {
    service.state.status = 404;
    const app = await runtime();
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(reads()).toBe(1);
    service.state.status = 200;
    service.state.notices = [{ id: 'n1', seq: 1, content: zh('一') }];
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(app.titles()).toEqual(['一']);
    app.stop();
  });

  it('waits for the next sign-in when the session is refused', async () => {
    service.state.status = 401;
    const app = await runtime();
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(reads()).toBe(1);
    expect(app.titles()).toEqual([]);

    service.state.status = 200;
    service.state.notices = [{ id: 'n1', seq: 1, content: zh('一') }];
    for (const listener of service.state.authListeners) listener({ hostedStatus: 'connected' }, { hostedStatus: 'needs-reauth' });
    await settle();
    expect(app.titles()).toEqual(['一']);
    app.stop();
  });
});
