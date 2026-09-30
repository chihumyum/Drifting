import { describe, expect, it, vi } from 'vitest';
vi.mock('../store/auth', () => ({ useAuthStore: { getState: () => ({ user: { id: 'local-library' } }) } }));
import { canUseFeature, ensureFeatureAccess } from './feature-access';
describe('local recovery capabilities', () => {
  it('allows Trash and history without subscriptions or network', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await ensureFeatureAccess('local-library');
    expect(canUseFeature('trash')).toBe(true); expect(canUseFeature('snapshot')).toBe(true); expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
  });
  it('rejects an operation for another local identity', async () => {
    await expect(ensureFeatureAccess('other')).rejects.toThrow('FEATURE_ACCESS_ACCOUNT_CHANGED');
  });
});
