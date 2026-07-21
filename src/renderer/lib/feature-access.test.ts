import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authRequired: true,
  authState: {
    isAuthenticated: true as boolean,
    user: { id: 'user-a' } as { id: string } | null,
  },
  getStatus: vi.fn(),
  rearmTrashEntitlementConflicts: vi.fn(),
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

vi.mock('../services/entity-sync.service', () => ({
  rearmTrashEntitlementConflicts: mocks.rearmTrashEntitlementConflicts,
}));

import {
  canUseFeature,
  ensureFeatureAccess,
  refreshFeatureAccess,
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
    mocks.rearmTrashEntitlementConflicts.mockReset();
    mocks.rearmTrashEntitlementConflicts.mockResolvedValue(0);
    resetFeatureAccess();
  });

  it('matches the server paid-plan and billing-status policy', async () => {
    mocks.getStatus.mockResolvedValueOnce(status('pro', 'active'));
    await ensureFeatureAccess('user-a');
    expect(canUseFeature('trash')).toBe(true);
    expect(mocks.rearmTrashEntitlementConflicts).toHaveBeenCalledTimes(1);

    mocks.getStatus.mockResolvedValueOnce(status('pro', 'canceled'));
    await ensureFeatureAccess('user-a', { forceRefresh: true });
    expect(canUseFeature('trash')).toBe(false);
    expect(mocks.rearmTrashEntitlementConflicts).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent refreshes for the same account', async () => {
    mocks.getStatus.mockResolvedValueOnce(status('studio', 'trialing'));
    await Promise.all([ensureFeatureAccess('user-a'), ensureFeatureAccess('user-a')]);

    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(canUseFeature('snapshot')).toBe(true);
  });

  it('does not let a destructive check skip recovery when it joins a background load', async () => {
    let resolveStatus: ((value: ReturnType<typeof status>) => void) | undefined;
    mocks.getStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    mocks.rearmTrashEntitlementConflicts.mockRejectedValue(new Error('database unavailable'));

    const background = refreshFeatureAccess('user-a');
    const destructive = ensureFeatureAccess('user-a');
    resolveStatus?.(status('pro', 'active'));

    await expect(background).resolves.toBeUndefined();
    await expect(destructive).rejects.toThrow('无法恢复待同步的回收站操作');
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(mocks.rearmTrashEntitlementConflicts).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an unhydrated account cannot be checked', async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error('offline'));

    await expect(ensureFeatureAccess('user-a')).rejects.toThrow('无法确认当前订阅状态');
    expect(useFeatureAccessStore.getState().hydrated).toBe(false);
    expect(canUseFeature('trash')).toBe(false);
  });

  it('hydrates paid UI state before a background trash re-arm completes', async () => {
    let finishRearm: (() => void) | undefined;
    mocks.getStatus.mockResolvedValueOnce(status('pro', 'active'));
    mocks.rearmTrashEntitlementConflicts.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finishRearm = () => resolve(2);
      }),
    );

    const hydration = refreshFeatureAccess('user-a');
    await vi.waitFor(() => {
      expect(mocks.rearmTrashEntitlementConflicts).toHaveBeenCalledTimes(1);
    });
    expect(useFeatureAccessStore.getState().hydrated).toBe(true);
    expect(canUseFeature('trash')).toBe(true);

    finishRearm?.();
    await hydration;
    expect(canUseFeature('trash')).toBe(true);
  });

  it('keeps UI entitlement hydrated when background conflict recovery fails', async () => {
    mocks.getStatus.mockResolvedValueOnce(status('studio', 'past_due'));
    mocks.rearmTrashEntitlementConflicts.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(refreshFeatureAccess('user-a')).resolves.toBeUndefined();
    expect(useFeatureAccessStore.getState().hydrated).toBe(true);
    expect(canUseFeature('trash')).toBe(true);
  });

  it('fails a destructive check when paid conflict recovery cannot complete', async () => {
    mocks.getStatus.mockResolvedValueOnce(status('studio', 'past_due'));
    mocks.rearmTrashEntitlementConflicts.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(ensureFeatureAccess('user-a')).rejects.toThrow('无法恢复待同步的回收站操作');
    expect(useFeatureAccessStore.getState().hydrated).toBe(true);
    expect(canUseFeature('trash')).toBe(true);
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
    expect(canUseFeature('trash')).toBe(false);
  });

  it('treats local-only mode as a hydrated free entitlement without networking', async () => {
    mocks.authRequired = false;

    await ensureFeatureAccess('user-a');

    expect(mocks.getStatus).not.toHaveBeenCalled();
    expect(useFeatureAccessStore.getState().hydrated).toBe(true);
    expect(canUseFeature('trash')).toBe(false);
  });
});
