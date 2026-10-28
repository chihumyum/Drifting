import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hosted: true, enabled: true, token: null as string | null }));
const sentry = vi.hoisted(() => ({ send: vi.fn(), log: vi.fn(), env: { VITE_SENTRY_DSN: '' } }));
vi.mock('../../lib/vite-runtime-env', () => ({ runtimeViteEnv: sentry.env }));
vi.mock('./sentry-reporter', () => ({ sendSentryReport: sentry.send, sendSentryLog: sentry.log }));
vi.mock('../../lib/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/config')>(),
  APP_CONFIG: { API_BASE_URL: 'https://sync.example.test/' },
  canUseHostedService: () => mocks.hosted,
}));
vi.mock('../../lib/session-token', () => ({ getSessionToken: () => mocks.token }));
vi.mock('../../store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ sendCrashLogs: mocks.enabled }) },
}));
const nativeReports = vi.hoisted(() => ({ take: vi.fn() }));
vi.mock('../../platform', () => ({
  platform: { diagnostics: { takeNativeCrashReports: nativeReports.take } },
}));
vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({ appInfo: { version: '0.1.0-alpha.2', platform: 'macos' }, nativePlatform: 'macos' }),
}));
import {
  flushCrashReports,
  reportCrash,
  reportIntegrityEvent,
  reportNativeCrashes,
  reportDiagnosticLog,
  resetCrashReporterForTests,
} from './crash-reporter';

const storage = new Map<string, string>();
const fetchMock = vi.fn();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('VITE_DRIFTING_CRASH_REPORTS_IN_DEV', '1');
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202 });
  mocks.hosted = true;
  mocks.enabled = true;
  mocks.token = null;
  sentry.env.VITE_SENTRY_DSN = '';
  sentry.send.mockReset().mockResolvedValue(true);
  sentry.log.mockReset();
  resetCrashReporterForTests();
});

it('routes configured reports to Sentry once, retains failed delivery, and bounds operational logs', async () => {
  sentry.env.VITE_SENTRY_DSN = 'https://0123456789abcdef0123456789abcdef@errors.example.test/42';
  mocks.token = 'must-never-go-to-sentry';
  sentry.send.mockResolvedValueOnce(false);
  reportIntegrityEvent('local-flush-failed', new Error('disk full'));
  await flushCrashReports();
  expect(storage.has('drifting.diagnostics.queue.v1')).toBe(true);
  await flushCrashReports();
  expect(storage.has('drifting.diagnostics.queue.v1')).toBe(false);
  expect(sentry.send).toHaveBeenCalledTimes(2);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(JSON.stringify(sentry.send.mock.calls)).not.toContain('must-never-go-to-sentry');
  for (let index = 0; index < 110; index++) reportDiagnosticLog('sync-cycle-failed');
  await vi.waitFor(() => expect(sentry.log).toHaveBeenCalledTimes(100));
});

it('stops an already draining queue from starting another upload after opt-out', async () => {
  let release!: () => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ ok: true, status: 202 });
  }));
  reportIntegrityEvent('first-before-opt-out');
  reportIntegrityEvent('second-before-opt-out');
  mocks.enabled = false;
  release();
  await flushCrashReports();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('keeps different minified JS columns distinct in Sentry mode while suppressing an exact repeat', async () => {
  sentry.env.VITE_SENTRY_DSN = 'https://0123456789abcdef0123456789abcdef@errors.example.test/42';
  const input = { kind: 'renderer-error' as const, severity: 'error' as const, name: 'TypeError', message: 'Cannot read property' };
  reportCrash({ ...input, stack: 'at render (tauri://localhost/assets/index-12345678.js:1:20)' });
  reportCrash({ ...input, stack: 'at render (tauri://localhost/assets/index-12345678.js:1:30)' });
  reportCrash({ ...input, stack: 'at render (tauri://localhost/assets/index-12345678.js:1:20)' });
  await flushCrashReports();
  expect(sentry.send).toHaveBeenCalledTimes(2);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

it('sends one content-free report per problem to the Hosted service', async () => {
  mocks.token = 'session-token';
  const error = new TypeError('他推开门的时候，雨已经停了，街上只剩下潮湿的灯光');
  error.stack = `TypeError: x\n    at render (tauri://localhost/assets/index-Bx9fK2aQ.js:1:2)`;
  reportCrash({ kind: 'renderer-error', severity: 'error', name: error.name, message: error.message, stack: error.stack });
  reportCrash({ kind: 'renderer-error', severity: 'error', name: error.name, message: error.message, stack: error.stack });
  await flushCrashReports();

  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://sync.example.test/api/diagnostics/v1/reports');
  expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer session-token' });
  const [report] = sentBodies();
  expect(report).toMatchObject({
    format: 'drifting.crash-report', kind: 'renderer-error', name: 'TypeError', message: '[text]',
    appVersion: '0.1.0-alpha.2', platform: 'macos',
  });
  expect(report.installationId).toMatch(/^diag-/);
  expect(JSON.stringify(report)).not.toContain('雨已经停了');
});

it('keeps unsent reports for the next launch and drops rejected ones', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  reportIntegrityEvent('local-flush-failed', new Error('disk full'), { reason: 'shutdown' });
  await flushCrashReports();
  expect(JSON.parse(storage.get('drifting.diagnostics.queue.v1')!)).toHaveLength(1);

  fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
  await flushCrashReports();
  expect(storage.has('drifting.diagnostics.queue.v1')).toBe(false);
  expect(sentBodies()[0]).toMatchObject({
    kind: 'integrity', fingerprint: 'integrity:local-flush-failed', context: { reason: 'shutdown' },
  });
});

it('sends nothing when the author turned reports off or there is no Hosted service', async () => {
  sentry.env.VITE_SENTRY_DSN = 'https://0123456789abcdef0123456789abcdef@errors.example.test/42';
  mocks.enabled = false;
  reportIntegrityEvent('a');
  mocks.enabled = true;
  mocks.hosted = false;
  reportIntegrityEvent('b');
  reportDiagnosticLog('sync-cycle-failed');
  await flushCrashReports();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(sentry.send).not.toHaveBeenCalled();
  expect(sentry.log).not.toHaveBeenCalled();
  expect(storage.has('drifting.diagnostics.queue.v1')).toBe(false);
});

it('sends native panics from the previous launch as fatal reports, and clears them when off', async () => {
  const panic = {
    message: 'index out of bounds', location: 'src/sync_object_store.rs:88', thread: 'tokio-runtime-worker',
    backtrace: '   0: drifting_lib::sync_object_store::read\n             at ./src/sync_object_store.rs:88:5',
    occurredAtMs: 1, appVersion: '0.1.0-alpha.1',
  };
  nativeReports.take.mockResolvedValueOnce([panic]);
  await reportNativeCrashes();
  await flushCrashReports();
  expect(sentBodies()[0]).toMatchObject({
    kind: 'native-panic', severity: 'fatal', name: 'RustPanic',
    fingerprint: 'native-panic:src-sync_object_store.rs:88',
    context: { thread: 'tokio-runtime-worker', crashedVersion: '0.1.0-alpha.1' },
  });
  expect(sentBodies()[0].stack).toContain('drifting_lib::sync_object_store::read');

  mocks.enabled = false;
  nativeReports.take.mockResolvedValueOnce([panic]);
  await reportNativeCrashes();
  expect(nativeReports.take).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('keeps sending live after an empty flush and never loses a report added during a send', async () => {
  await flushCrashReports(); // the startup flush with nothing queued
  let release!: () => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 202 });
  }));
  reportIntegrityEvent('first');
  await Promise.resolve();
  reportIntegrityEvent('second'); // queued while the first is in flight
  release();
  await flushCrashReports();
  await flushCrashReports();
  expect(sentBodies().map((body) => body.fingerprint)).toEqual(['integrity:first', 'integrity:second']);
  expect(storage.has('drifting.diagnostics.queue.v1')).toBe(false);
});
