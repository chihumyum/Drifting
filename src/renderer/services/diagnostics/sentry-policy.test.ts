import { expect, it } from 'vitest';
import { configuredSentryDsn, sanitizeSentryEvent, sanitizeSentryLog } from './sentry-policy';

it('accepts only an explicit public HTTPS DSN, without upload credentials or query data', () => {
  const valid = 'https://0123456789abcdef0123456789abcdef@errors.example.test/42';
  expect(configuredSentryDsn(valid)).toBe(valid);
  for (const invalid of [undefined, '', 'broken', valid.replace('https:', 'http:'), `${valid}?token=secret`,
    valid.replace('@', ':password@'), valid.replace('/42', '/project')]) expect(configuredSentryDsn(invalid)).toBeNull();
});

it('drops ambient scope, request, prose, credentials and untrusted stack locations', () => {
  const output = sanitizeSentryEvent({
    type: undefined,
    tags: { kind: 'renderer-error', project: 'private title' },
    user: { email: 'writer@example.test', ip_address: '127.0.0.1' },
    request: { url: 'https://private.example.test/manuscript', data: 'private text' },
    breadcrumbs: [{ message: 'private text' }], extra: { token: 'private-secret' },
    contexts: { arbitrary: { prose: 'private text' } },
    exception: { values: [{ type: 'TypeError', value: 'Bearer session-secret sk-1234567890 writer@example.test',
      stacktrace: { frames: [
        { filename: 'file:///private/writing/chapter.txt', vars: { prose: 'private text' } },
        { filename: 'https://app.example.test/assets/index-123.js?secret=token' },
        { filename: 'tauri://localhost/assets/index-123.js', lineno: 1, colno: 4, vars: { token: 'private-secret' } },
      ] } }] },
  });
  expect(output.exception?.values?.[0].stacktrace?.frames).toHaveLength(1);
  const serialized = JSON.stringify(output);
  for (const privateValue of ['private text', 'private-secret', 'session-secret', 'sk-1234567890', 'writer@example.test', 'chapter.txt', 'project']) {
    expect(serialized).not.toContain(privateValue);
  }
});

it('accepts machine log messages and bounded runtime and deployment attributes only', () => {
  expect(sanitizeSentryLog({ level: 'info', message: 'a private manuscript' })).toBeNull();
  expect(sanitizeSentryLog({ level: 'warn', message: 'sync-cycle-failed', attributes: {
    bytes: 3, durationMs: Infinity, appVersion: '0.1.0', platform: 'macos', token: 'secret', projectId: 'private',
    'sentry.environment': 'acceptance', 'sentry.release': 'drifting@0.1.0+synthetic', 'user.email': 'writer@example.test',
  } })?.attributes).toEqual({ bytes: 3, appVersion: '0.1.0', platform: 'macos',
    'sentry.environment': 'acceptance', 'sentry.release': 'drifting@0.1.0+synthetic' });
  expect(sanitizeSentryLog({ level: 'info', message: 'update-check-completed', attributes: {
    'sentry.environment': '/synthetic/private-location', 'sentry.release': 'https://private.example.test/token',
  } })?.attributes).toEqual({});
});
