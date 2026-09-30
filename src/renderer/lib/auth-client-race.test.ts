import { afterEach, describe, expect, it, vi } from 'vitest';
const token = vi.hoisted(() => ({ value: 'old' as string | null, revision: 0, save: vi.fn() }));
vi.mock('./config', () => ({ canUseHostedService: () => true }));
vi.mock('./session-token', () => ({
  getSessionToken: () => token.value,
  getSessionTokenRevision: () => token.revision,
  setSessionToken: (value: string) => {
    token.save(value);
    token.value = value;
    token.revision++;
  },
}));
import { hostedAuthFetch } from './auth-client';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('Hosted credential response ownership', () => {
  it('ignores stale response credentials after another login or logout', async () => {
    token.value = 'old';
    token.revision = 0;
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = hostedAuthFetch('http://localhost:3000/api/auth/get-session');
    token.value = 'new';
    token.revision++;
    finish(new Response('{}', { headers: { 'set-auth-token': 'old' } }));
    await pending;
    expect(token.save).not.toHaveBeenCalled();
    expect(token.value).toBe('new');
  });
  it('persists a current sign-in response once without changing the revision for identical tokens', async () => {
    token.value = null;
    token.revision = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { headers: { 'set-auth-token': 'verified' } })),
    );
    await hostedAuthFetch('http://localhost:3000/api/auth/sign-in/email');
    await hostedAuthFetch('http://localhost:3000/api/auth/get-session');
    expect(token.save).toHaveBeenCalledTimes(1);
    expect(token.value).toBe('verified');
    expect(token.revision).toBe(1);
  });
});
