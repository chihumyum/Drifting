import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authRequired: true,
  authState: {
    isAuthenticated: true as boolean,
    user: { id: 'user-a' } as { id: string } | null,
  },
  getStatus: vi.fn(),
}));

vi.mock('../services/subscription.service', () => ({
  subscriptionService: { getStatus: mocks.getStatus },
}));

vi.mock('../store/auth', () => ({
  useAuthStore: { getState: () => mocks.authState },
}));

vi.mock('./config', () => ({
  isAuthRequired: () => mocks.authRequired,
}));

import {
  canUseFeature,
  ensureFeatureAccess,
  resetFeatureAccess,
  useFeatureAccessStore,
} from './feature-access';

function status(plan: string, billingStatus: string) {
  return {
    plan,
    status: billingStatus,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    stripeCustomerId: null,
    stripeConfigured: true,
  };
}

describe('feature access hydration', () => {
  beforeEach(() => {
    mocks.authRequired = true;
    mocks.authState.isAuthenticated = true;
    mocks.authState.user = { id: 'user-a' };
    mocks.getStatus.mockReset();
    resetFeatureAccess();
  });

  it('matches the hosted paid-plan cache without touching a retired sync outbox', async () => {
    mocks.getStatus.mockResolvedValueOnce(status('pro', 'active'));
    await ensureFeatureAccess('user-a');
    expect(canUseFeature('trash')).toBe(true);

    mocks.getStatus.mockResolvedValueOnce(status('pro', 'canceled'));
    await ensureFeatureAccess('user-a', { forceRefresh: true });
    expect(canUseFeature('trash')).toBe(false);
  });

  it('deduplicates concurrent refreshes for the same account', async () => {
    mocks.getStatus.mockResolvedValueOnce(status('studio', 'trialing'));
    await Promise.all([ensureFeatureAccess('user-a'), ensureFeatureAccess('user-a')]);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(canUseFeature('snapshot')).toBe(true);
  });

  it('fails closed when an unhydrated hosted account cannot be checked', async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(ensureFeatureAccess('user-a')).rejects.toThrow('无法确认当前订阅状态');
    expect(useFeatureAccessStore.getState().hydrated).toBe(false);
    expect(canUseFeature('trash')).toBe(false);
  });

  it('does not apply a response after the authenticated account changes', async () => {
    let resolveStatus: ((value: ReturnType<typeof status>) => void) | undefined;
    mocks.getStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const hydration = ensureFeatureAccess('user-a');
    mocks.authState.user = { id: 'user-b' };
    resolveStatus?.(status('pro', 'active'));
    await expect(hydration).rejects.toThrow('FEATURE_ACCESS_ACCOUNT_CHANGED');
    expect(useFeatureAccessStore.getState().hydrated).toBe(false);
  });

  it('grants local Trash and snapshot history without networking', async () => {
    mocks.authRequired = false;
    await ensureFeatureAccess('user-a');
    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(canUseFeature('trash')).toBe(true);
    expect(canUseFeature('snapshot')).toBe(true);
  });
});
