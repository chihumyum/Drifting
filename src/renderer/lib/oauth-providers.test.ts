import { beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  hosted: true,
  responses: [] as (() => Response)[],
  urls: [] as string[],
}));

vi.mock('./config', () => ({
  APP_CONFIG: { API_BASE_URL: 'http://localhost:3000/' },
  canUseHostedService: () => service.hosted,
}));
vi.mock('./auth-client', () => ({
  hostedAccountFetch: async (url: string) => {
    service.urls.push(url);
    const next = service.responses.shift();
    if (!next) throw new Error('offline');
    return next();
  },
}));

import { loadOAuthProviders, resetOAuthProvidersForTests } from './oauth-providers';

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('server-declared social sign-in providers', () => {
  beforeEach(() => {
    resetOAuthProvidersForTests();
    Object.assign(service, { hosted: true, responses: [], urls: [] });
  });

  it('offers the providers both the service and this client know', async () => {
    service.responses.push(json({ providers: [{ id: 'wechat' }, { id: 'google' }, null] }));
    expect(await loadOAuthProviders()).toEqual(['google']);
    expect(service.urls).toEqual(['http://localhost:3000/api/auth/providers']);
    // Kept for the session.
    expect(await loadOAuthProviders()).toEqual(['google']);
    expect(service.urls).toHaveLength(1);
  });

  it('offers none from an older service, a failure or offline, and asks again next time', async () => {
    service.responses.push(json({ code: 'NOT_FOUND' }, 404));
    expect(await loadOAuthProviders()).toEqual([]);
    expect(await loadOAuthProviders()).toEqual([]);
    service.responses.push(json({ providers: 'google' }));
    expect(await loadOAuthProviders()).toEqual([]);
    service.responses.push(json({ providers: [{ id: 'google' }] }));
    expect(await loadOAuthProviders()).toEqual(['google']);
    expect(service.urls).toHaveLength(4);
  });

  it('never asks a service in a local-only build', async () => {
    service.hosted = false;
    expect(await loadOAuthProviders()).toEqual([]);
    expect(service.urls).toEqual([]);
  });
});
