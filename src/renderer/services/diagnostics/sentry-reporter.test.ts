import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CrashReportPayload } from './crash-reporter';

const env = vi.hoisted(() => ({ VITE_SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@errors.example.test/42',
  VITE_SENTRY_RELEASE: 'drifting@0.1.0+synthetic', VITE_SENTRY_ENVIRONMENT: 'acceptance' }));
vi.mock('../../lib/vite-runtime-env', () => ({ runtimeViteEnv: env }));
import { flushSentryLogs, resetSentryReporterForTests, sendSentryLog, sendSentryReport } from './sentry-reporter';

const fetchMock = vi.fn();
let allowed = true;
const gate = () => allowed;
const report: CrashReportPayload = {
  format: 'drifting.crash-report', formatVersion: 1, kind: 'renderer-error', severity: 'error',
  fingerprint: 'renderer-error:TypeError:index.js:1', name: 'TypeError', message: 'Cannot read property',
  stack: 'at render (tauri://localhost/assets/index-12345678.js:1:234)',
  appVersion: '0.1.0-alpha.1', platform: 'macos', installationId: 'diag-00000000-0000-4000-8000-000000000001',
  occurredAt: '2026-10-28T01:00:00.000Z', context: {},
};
const packets = () => fetchMock.mock.calls.map(([, init]) => String((init as RequestInit).body).split('\n').map(line => JSON.parse(line)));

beforeEach(() => {
  allowed = true;
  fetchMock.mockReset().mockImplementation(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => { await resetSentryReporterForTests(); vi.unstubAllGlobals(); });

it('sends a real SDK envelope with code frames, release and an anonymous installation, without app credentials', async () => {
  expect(await sendSentryReport(report, gate)).toBe(true);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toMatch(/^https:\/\/errors\.example\.test\/api\/42\/envelope\//);
  expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: false });
  expect(init.headers).not.toHaveProperty('Authorization');
  const [header, item, event] = packets()[0];
  expect(header.event_id).toMatch(/^[a-f0-9]{32}$/);
  expect(item.type).toBe('event');
  expect(event).toMatchObject({ release: env.VITE_SENTRY_RELEASE, environment: 'acceptance', user: { id: report.installationId } });
  expect(event.exception.values[0].stacktrace.frames[0]).toMatchObject({ lineno: 1, colno: 234 });
  expect(event.fingerprint).toBeUndefined();
  expect(event.request).toBeUndefined();
  expect(event.breadcrumbs).toBeUndefined();
});

it('keeps retries identifiable and distinguishes accepted, rejected and failed delivery', async () => {
  fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
  expect(await sendSentryReport(report, gate)).toBe(false);
  expect(await sendSentryReport(report, gate)).toBe(true);
  expect(packets()[0][0].event_id).toBe(packets()[1][0].event_id);
  fetchMock.mockRejectedValueOnce(new TypeError('network unavailable'));
  expect(await sendSentryReport(report, gate)).toBe(false);
  fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 400 }));
  expect(await sendSentryReport(report, gate)).toBe(true); // terminal rejection, same policy as Hosted
});

it('honors opt-out both before initialization and after the SDK is initialized', async () => {
  allowed = false;
  expect(await sendSentryReport(report, gate)).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  allowed = true;
  expect(await sendSentryReport(report, gate)).toBe(true);
  allowed = false;
  sendSentryLog('sync-cycle-failed', {}, { appVersion: '0.1.0', platform: 'macos' }, gate);
  expect(await sendSentryReport(report, gate)).toBe(false);
  await flushSentryLogs();
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('sends bounded structured logs through the real SDK and rechecks consent before a buffered log leaves', async () => {
  sendSentryLog('update-download-completed', { bytes: 100 }, { appVersion: '0.1.0', platform: 'macos' }, gate);
  await flushSentryLogs();
  const packet = packets().find(packet => packet[1].type === 'log');
  expect(packet).toBeDefined();
  expect(JSON.stringify(packet)).toContain('update-download-completed');
  expect(await sendSentryReport(report, gate)).toBe(true);
  const error = packets().find(packet => packet[1].type === 'event')?.[2];
  expect(error.breadcrumbs).toEqual([{ category: 'drifting.operation', message: 'update-download-completed',
    timestamp: expect.any(Number), data: { bytes: 100 } }]);
  const sent = fetchMock.mock.calls.length;
  sendSentryLog('update-install-started', {}, { appVersion: '0.1.0', platform: 'macos' }, gate);
  allowed = false;
  await flushSentryLogs();
  expect(fetchMock).toHaveBeenCalledTimes(sent);
});

it('retains native panic identity and bounded backtrace without claiming native crash symbolication', async () => {
  expect(await sendSentryReport({ ...report, kind: 'native-panic', name: 'RustPanic', severity: 'fatal',
    fingerprint: 'native-panic:sync.rs:42', stack: '0: drifting_lib::sync::apply',
    context: { crashedVersion: '0.1.0-alpha.0' } }, gate)).toBe(true);
  expect(packets()[0][2]).toMatchObject({ level: 'fatal', fingerprint: ['native-panic:sync.rs:42'],
    release: 'drifting@0.1.0-alpha.0', tags: { appVersion: '0.1.0-alpha.0' },
    contexts: { native: { backtrace: '0: drifting_lib::sync::apply' } } });
});

it('preserves injected Debug IDs through privacy filtering for exact source-map lookup', async () => {
  const debugId = '00000000-0000-4000-8000-000000000042';
  vi.stubGlobal('_sentryDebugIds', { [`Error\n${report.stack}`]: debugId });
  expect(await sendSentryReport(report, gate)).toBe(true);
  expect(packets()[0][2].debug_meta.images).toEqual([
    { type: 'sourcemap', code_file: 'tauri://localhost/assets/index-12345678.js', debug_id: debugId },
  ]);
});

it('parses a WebKit-style packaged Tauri stack without losing its source location', async () => {
  expect(await sendSentryReport({ ...report,
    stack: 'render@tauri://localhost/assets/index-12345678.js:2:44' }, gate)).toBe(true);
  expect(packets()[0][2].exception.values[0].stacktrace.frames[0]).toMatchObject({
    filename: 'tauri://localhost/assets/index-12345678.js', lineno: 2, colno: 44,
  });
});
