/**
 * Feature access — single source of truth for paywall checks.
 *
 * The current plan is cached at module scope and hydrated lazily on first
 * read (or up-front by the app shell calling `refreshFeatureAccess()`).
 * Anything that needs to gate behavior synchronously (e.g. "should this
 * delete go to trash or hard-delete?") reads through `canUseFeature()`.
 *
 * The cache is advisory UI state only. The server independently verifies both
 * the paid plan and its billing status before accepting cloud snapshot/trash
 * operations. Destructive client decisions must also await plan hydration so
 * a paid user is never hard-deleted merely because startup is still loading.
 */
import { create } from 'zustand';
import { subscriptionService, type SubscriptionStatus } from '../services/subscription.service';

export type Plan = 'free' | 'pro' | 'studio';

export type PaidFeature = 'trash' | 'snapshot';

const PAID_PLANS = new Set<Plan>(['pro', 'studio']);

interface FeatureAccessState {
  plan: Plan;
  status: SubscriptionStatus | null;
  setStatus: (status: SubscriptionStatus | null) => void;
}

export const useFeatureAccessStore = create<FeatureAccessState>((set) => ({
  plan: 'free',
  status: null,
  setStatus: (status) =>
    set({
      status,
      plan: normalizePlan(status?.plan),
    }),
}));

function normalizePlan(raw?: string | null): Plan {
  if (raw === 'pro' || raw === 'studio') return raw;
  return 'free';
}

/**
 * Sync read of the cached plan. Returns 'free' until `refreshFeatureAccess`
 * has resolved at least once.
 */
export function currentPlan(): Plan {
  return useFeatureAccessStore.getState().plan;
}

export function canUseFeature(_feature: PaidFeature): boolean {
  return PAID_PLANS.has(currentPlan());
}

/** React hook variant — re-renders when the cached plan changes. */
export function useCanUseFeature(_feature: PaidFeature): boolean {
  const plan = useFeatureAccessStore((s) => s.plan);
  return PAID_PLANS.has(plan);
}

let refreshInFlight: Promise<void> | null = null;

/**
 * Hydrate the cached subscription status from the server. Safe to call from
 * app boot and after any subscription change (e.g. checkout completion).
 */
export async function refreshFeatureAccess(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const status = await subscriptionService.getStatus();
      useFeatureAccessStore.getState().setStatus(status);
    } catch {
      // Network/transient failures leave the cached plan as-is. Subsequent
      // calls will retry. Don't reset to 'free' — that would aggressively
      // pull the rug from under paid users on a flaky connection.
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
