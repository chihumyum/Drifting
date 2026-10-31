import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ hosted: true, online: true, crashReports: true, token: null as string | null }));
vi.mock('../../lib/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/config')>(),
  APP_CONFIG: {
    API_BASE_URL: 'https://sync.example.test/',
    SUPPORT_EMAIL: 'support@drifting.cc',
    get LOCAL_ONLY_MODE() { return !mocks.hosted; },
  },
  canUseHostedService: () => mocks.hosted && mocks.online,
}));
vi.mock('../../lib/session-token', () => ({ getSessionToken: () => mocks.token }));
vi.mock('../../store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ sendCrashLogs: mocks.crashReports }) },
}));
vi.mock('../../platform', () => ({ platform: { diagnostics: { takeNativeCrashReports: vi.fn() } } }));
vi.mock('../../platform/runtime', () => ({
  getPlatformRuntime: () => ({ appInfo: { version: '0.1.0-alpha.3', platform: 'macos' }, nativePlatform: 'macos' }),
}));
import {
  buildFeedbackPayload,
  feedbackDelivery,
  feedbackEmailUrl,
  feedbackProblems,
  sendFeedback,
  type FeedbackDraft,
} from './feedback';
import { createSanitizedDiagnosticSummary } from './sanitized-summary';

const storage = new Map<string, string>();
const fetchMock = vi.fn();
// Synthetic prose that must never leave with feedback the author did not type.
const MANUSCRIPT = '他推开门的时候，雨已经停了，街上只剩下潮湿的灯光。';

function summary(): string {
  return createSanitizedDiagnosticSummary({
    runtime: {
      appInfo: { version: '0.1.0-alpha.3', platform: 'macos', architecture: 'aarch64' },
      nativePlatform: 'macos',
      target: 'desktop',
      capabilities: null,
    } as never,
    authority: {
      status: 'attention', mode: 'hosted', errorCode: MANUSCRIPT,
      activeSyncGenerations: 1, readySyncGenerations: 1, provisioningSyncGenerations: 0,
      pausedSyncGenerations: 0, attentionSyncGenerations: 1,
    } as never,
    sync: { mounted: true, diagnostics: { online: true, suspended: false, generations: [] } } as never,
    update: { phase: 'idle', update: null, downloadedBytes: 0, totalBytes: null, error: `failed: ${MANUSCRIPT}` } as never,
    generatedAt: '2026-10-31T08:00:00.000Z',
  });
}

const draft = (change: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  message: '  The outline froze after I renamed an act.  ',
  contactEmail: 'author@example.com',
  diagnostics: summary(),
  followUp: null,
  locale: 'zh-CN',
  ...change,
});

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubEnv('VITE_DRIFTING_CRASH_REPORTS_IN_DEV', '1');
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202 });
  Object.assign(mocks, { hosted: true, online: true, crashReports: true, token: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('asks for a message and a reply-to address that can be answered', () => {
  expect(feedbackProblems({ message: '   ', contactEmail: '' })).toEqual(['empty-message']);
  expect(feedbackProblems({ message: 'x'.repeat(5001), contactEmail: '' })).toEqual(['message-too-long']);
  expect(feedbackProblems({ message: 'Hi', contactEmail: 'not an address' })).toEqual(['invalid-email']);
  expect(feedbackProblems({ message: 'Hi', contactEmail: 'a@b.c\nBcc: x@y.zz' })).toEqual(['invalid-email']);
  expect(feedbackProblems({ message: 'Hi', contactEmail: '' })).toEqual([]);
  expect(feedbackProblems({ message: 'Hi', contactEmail: ' author@example.com ' })).toEqual([]);
});

it('builds a bounded payload with the author’s words and only the sanitized summary', () => {
  const payload = buildFeedbackPayload(draft(), new Date('2026-10-31T08:01:00.000Z'));
  expect(Object.keys(payload).sort()).toEqual([
    'appVersion', 'contactEmail', 'diagnostics', 'format', 'formatVersion', 'installationId', 'kind',
    'locale', 'message', 'platform', 'related', 'submittedAt',
  ]);
  expect(payload).toMatchObject({
    format: 'drifting.feedback', formatVersion: 1, kind: 'feedback',
    message: 'The outline froze after I renamed an act.', contactEmail: 'author@example.com',
    related: null, appVersion: '0.1.0-alpha.3', platform: 'macos', locale: 'zh-CN',
    submittedAt: '2026-10-31T08:01:00.000Z',
  });
  expect(payload.installationId).toMatch(/^diag-/);
  expect(payload.diagnostics).toMatchObject({
    format: 'drifting.sanitized-diagnostics',
    privacy: { manuscriptIncluded: false, credentialsIncluded: false },
  });
  expect(JSON.stringify(payload)).not.toContain('雨已经停了');
});

it('sends no summary when the author detaches it, and no address when left empty', () => {
  const payload = buildFeedbackPayload(draft({ diagnostics: null, contactEmail: '  ' }));
  expect(payload.diagnostics).toBeNull();
  expect(payload.contactEmail).toBeNull();
});

it('names the crash a follow-up explains', () => {
  const followUp = {
    kind: 'render-failure' as const, fingerprint: 'render-failure:TypeError:AgentTranscript',
    occurredAt: '2026-10-31T07:59:00.000Z', reportId: '9b3c1f0e-1d2a-4c55-9a51-0d7b1b6f2e10',
  };
  expect(buildFeedbackPayload(draft({ followUp }))).toMatchObject({ kind: 'crash-follow-up', related: followUp });
});

it('posts to the Hosted service with the session, even with automatic fault reports off', async () => {
  mocks.crashReports = false;
  mocks.token = 'session-token';
  expect(feedbackDelivery()).toBe('hosted');
  await expect(sendFeedback(draft())).resolves.toBe(true);
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe('https://sync.example.test/api/diagnostics/v1/feedback');
  expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer session-token' });
  expect(JSON.parse((init as RequestInit).body as string).kind).toBe('feedback');
});

it('reports failure so the dialog can fall back to mail', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
  await expect(sendFeedback(draft())).resolves.toBe(false);
  fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
  await expect(sendFeedback(draft())).resolves.toBe(false);
});

it('hands feedback to the mail client without a Hosted service or a network', async () => {
  mocks.hosted = false;
  expect(feedbackDelivery()).toBe('email');
  mocks.hosted = true;
  vi.stubGlobal('navigator', { onLine: false });
  expect(feedbackDelivery()).toBe('email');
  await expect(sendFeedback(draft())).resolves.toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();

  const url = feedbackEmailUrl(draft(), 'Drifting 反馈');
  expect(url.startsWith('mailto:support@drifting.cc?subject=Drifting%20%E5%8F%8D%E9%A6%88&body=')).toBe(true);
  const body = decodeURIComponent(url.slice(url.indexOf('&body=') + 6));
  expect(body).toContain('The outline froze after I renamed an act.');
  expect(body).toContain('Drifting 0.1.0-alpha.3 · macos');
  expect(body).toContain('"format": "drifting.sanitized-diagnostics"');
  expect(body).not.toContain('雨已经停了');
  expect(decodeURIComponent(feedbackEmailUrl(draft({ diagnostics: null }), 'x'))).not.toContain('sanitized-diagnostics');
});

it('reads nothing from the manuscript, the database or credentials', () => {
  const sources = ['./feedback.ts', '../../features/feedback/FeedbackDialog.tsx']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
  for (const source of sources) {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
    for (const path of imports) {
      expect(path).not.toMatch(/yjs|y-prosemirror|editor|prose|database|db\/|repositories|keychain|secret/i);
    }
  }
});
