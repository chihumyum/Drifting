import { describe, expect, it, vi } from 'vitest';

import { apiClient } from './axios-config';

describe('hosted api boundary', () => {
  it('fails closed before dispatching a request in the default local-only build', async () => {
    const adapter = vi.fn();

    await expect(apiClient.get('/api/account/sessions', { adapter })).rejects.toMatchObject({
      code: 'HOSTED_SERVICE_DISABLED',
    });
    expect(adapter).not.toHaveBeenCalled();
  });
});
