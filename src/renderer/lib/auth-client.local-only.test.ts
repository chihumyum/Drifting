import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authClient, hostedAuthFetch } from './auth-client';

describe('local-only Better Auth transport', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects its custom fetch implementation before global fetch dispatch', async () => {
    await expect(hostedAuthFetch('http://localhost:3000/api/auth/get-session')).rejects.toMatchObject(
      {
        code: 'HOSTED_SERVICE_DISABLED',
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a direct exported authClient call transport-level fail-closed', async () => {
    await expect(authClient.getSession()).rejects.toMatchObject({
      code: 'HOSTED_SERVICE_DISABLED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
