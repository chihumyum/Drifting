/**
 * Feature access — single source of truth for paywall checks.
 *
 * Local-only builds own Trash and snapshot history as ordinary on-device
 * capabilities, so they are available without an account or network request.
 * Hosted builds retain the current account-scoped entitlement cache and must
 * hydrate it before destructive decisions.
 *
 * The hosted cache is advisory UI state only. Its server independently verifies
 * both plan and billing status before accepting hosted snapshot/trash operations.
 * Destructive hosted decisions await hydration so a paid user is never
 * hard-deleted merely because startup is still loading.
 */
import { create } from 'zustand';
import { subscriptionService, type SubscriptionStatus } from '../services/subscription.service';
import { useAuthStore } from '../store/auth';
import { isAuthRequired } from './config';

export type Plan = 'free' | 'pro' | 'studio';

export type RecoverableFeature = 'trash' | 'snapshot';

const PAID_PLANS = new Set<Plan>(['pro', 'studio']);
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

interface FeatureAccessState {
  plan: Plan;
  status: SubscriptionStatus | null;
  subjectId: string | null;
  hydrated: boolean;
  setStatus: (subjectId: string, status: SubscriptionStatus | null) => void;
  prepareSubject: (subjectId: string) => void;
  reset: () => void;
}

export const useFeatureAccessStore = create<FeatureAccessState>((set) => ({
  plan: 'free',
  status: null,
  subjectId: null,
  hydrated: false,
  setStatus: (subjectId, status) =>
    set({
      subjectId,
      status,
      plan: normalizePlan(status?.plan),
      hydrated: true,
    }),
  prepareSubject: (subjectId) =>
    set((state) =>
      state.subjectId === subjectId
        ? state
        : {
            subjectId,
            status: null,
            plan: 'free',
            hydrated: false,
          },
    ),
  reset: () =>
    set({
      subjectId: null,
      status: null,
      plan: 'free',
      hydrated: false,
    }),
}));

function normalizePlan(raw?: string | null): Plan {
  if (raw === 'pro' || raw === 'studio') return raw;
  return 'free';
}

function statusHasPaidEntitlement(status: SubscriptionStatus | null): boolean {
  return PAID_PLANS.has(normalizePlan(status?.plan)) && ENTITLED_STATUSES.has(status?.status ?? '');
}

/**
 * Sync read of the cached plan. Returns 'free' until `refreshFeatureAccess`
 * has resolved at least once.
 */
export function currentPlan(): Plan {
  return useFeatureAccessStore.getState().plan;
}

export function canUseFeature(_feature: RecoverableFeature): boolean {
  if (!isAuthRequired()) return true;
  const { hydrated, status } = useFeatureAccessStore.getState();
  return hydrated && statusHasPaidEntitlement(status);
}

/** React hook variant — re-renders when the cached plan changes. */
export function useCanUseFeature(_feature: RecoverableFeature): boolean {
  const status = useFeatureAccessStore((s) => s.status);
  const hydrated = useFeatureAccessStore((s) => s.hydrated);
  return !isAuthRequired() || (hydrated && statusHasPaidEntitlement(status));
}

const refreshInFlight = new Map<string, Promise<void>>();

function assertActiveSubject(subjectId: string): void {
  const auth = useAuthStore.getState();
  if (!auth.isAuthenticated || auth.user?.id !== subjectId) {
    throw new Error('FEATURE_ACCESS_ACCOUNT_CHANGED');
  }
}

function loadFeatureAccess(subjectId: string): Promise<void> {
  const existing = refreshInFlight.get(subjectId);
  if (existing) return existing;

  const operation = (async () => {
    assertActiveSubject(subjectId);
    useFeatureAccessStore.getState().prepareSubject(subjectId);

    if (!isAuthRequired()) {
      useFeatureAccessStore.getState().setStatus(subjectId, null);
      return;
    }

    const status = await subscriptionService.getStatus();
    assertActiveSubject(subjectId);
    if (useFeatureAccessStore.getState().subjectId === subjectId) {
      useFeatureAccessStore.getState().setStatus(subjectId, status);
    }
  })();

  refreshInFlight.set(subjectId, operation);
  void operation
    .finally(() => {
      if (refreshInFlight.get(subjectId) === operation) {
        refreshInFlight.delete(subjectId);
      }
    })
    .catch(() => {
      // The original promise carries the rejection to its caller. This branch
      // only handles the promise returned by finally(), avoiding an unhandled
      // rejection when a background refresh fails.
    });
  return operation;
}

/**
 * Hydrate the cached subscription status from the server. Safe to call from
 * app boot and after any subscription change (e.g. checkout completion).
 */
export async function refreshFeatureAccess(subjectId: string): Promise<void> {
  try {
    await loadFeatureAccess(subjectId);
  } catch {
    // Background hydration is best-effort. A destructive caller uses
    // ensureFeatureAccess(), which surfaces failure instead of guessing Free.
    return;
  }

}

export function resetFeatureAccess(): void {
  useFeatureAccessStore.getState().reset();
}

/**
 * Establish the capability boundary before choosing between a recoverable
 * soft-delete and an irreversible hard-delete. Local-only builds resolve this
 * without networking; hosted builds hydrate the current account entitlement.
 */
export async function ensureFeatureAccess(
  subjectId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<void> {
  assertActiveSubject(subjectId);
  const state = useFeatureAccessStore.getState();
  if (options.forceRefresh || state.subjectId !== subjectId || !state.hydrated) {
    try {
      await loadFeatureAccess(subjectId);
    } catch (error) {
      if (error instanceof Error && error.message === 'FEATURE_ACCESS_ACCOUNT_CHANGED') {
        throw error;
      }
      const wrapped = new Error('无法确认当前订阅状态，请检查网络后重试。') as Error & {
        cause?: unknown;
      };
      wrapped.cause = error;
      throw wrapped;
    }
  }

}
