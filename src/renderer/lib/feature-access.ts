/**
 * Feature access — single source of truth for paywall checks.
 *
 * The current entitlement is cached per authenticated user and hydrated
 * up-front by the app shell. Synchronous reads are suitable for presentation;
 * destructive decisions must call `ensureFeatureAccess()` first.
 *
 * The cache is advisory UI state only. The server independently verifies both
 * the paid plan and its billing status before accepting cloud snapshot/trash
 * operations. Destructive client decisions must also await plan hydration so
 * a paid user is never hard-deleted merely because startup is still loading.
 */
import { create } from 'zustand';
import { subscriptionService, type SubscriptionStatus } from '../services/subscription.service';
import { useAuthStore } from '../store/auth';
import { isAuthRequired } from './config';

export type Plan = 'free' | 'pro' | 'studio';

export type PaidFeature = 'trash' | 'snapshot';

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

let paidTrashRearmInFlight: { subjectId: string; operation: Promise<void> } | null = null;

async function rearmPaidTrashOperations(subjectId: string): Promise<void> {
  assertActiveSubject(subjectId);
  const state = useFeatureAccessStore.getState();
  if (
    !isAuthRequired() ||
    state.subjectId !== subjectId ||
    !state.hydrated ||
    !statusHasPaidEntitlement(state.status)
  ) {
    return;
  }

  const existing = paidTrashRearmInFlight;
  if (existing?.subjectId === subjectId) return existing.operation;
  if (existing) {
    try {
      await existing.operation;
    } catch {
      // The old subject's caller owns its failure. Serialize account-scoped DB
      // recovery, then re-check that this subject is still active below.
    }
  }

  const operation = (async () => {
    // Keep the dependency one-way at module initialization: entity sync
    // already sits beneath usecases that import this feature gate.
    const { rearmTrashEntitlementConflicts } = await import('../services/entity-sync.service');
    assertActiveSubject(subjectId);
    await rearmTrashEntitlementConflicts();
    assertActiveSubject(subjectId);
  })();
  paidTrashRearmInFlight = { subjectId, operation };
  try {
    await operation;
  } finally {
    if (paidTrashRearmInFlight?.operation === operation) paidTrashRearmInFlight = null;
  }
}

/**
 * Sync read of the cached plan. Returns 'free' until `refreshFeatureAccess`
 * has resolved at least once.
 */
export function currentPlan(): Plan {
  return useFeatureAccessStore.getState().plan;
}

export function canUseFeature(_feature: PaidFeature): boolean {
  const { hydrated, status } = useFeatureAccessStore.getState();
  return hydrated && statusHasPaidEntitlement(status);
}

/** React hook variant — re-renders when the cached plan changes. */
export function useCanUseFeature(_feature: PaidFeature): boolean {
  const status = useFeatureAccessStore((s) => s.status);
  const hydrated = useFeatureAccessStore((s) => s.hydrated);
  return hydrated && statusHasPaidEntitlement(status);
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

  try {
    // UI hydration must not depend on SQLite being ready. App boot invokes
    // this above the project-scoped database owner, so recovery is best-effort
    // here and is enforced again by every destructive caller below.
    await rearmPaidTrashOperations(subjectId);
  } catch {
    // Keep the freshly confirmed entitlement visible. A delete/restore path
    // will await the same recovery and fail closed if it still cannot run.
  }
}

export function resetFeatureAccess(): void {
  useFeatureAccessStore.getState().reset();
}

/**
 * Establish a current, account-scoped entitlement before choosing between a
 * recoverable paid action and an irreversible free-tier action.
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

  try {
    // Do not rely on loadFeatureAccess's in-flight deduplication for this.
    // A background caller may own that promise and intentionally treats DB
    // recovery as best-effort; destructive decisions must await it explicitly.
    await rearmPaidTrashOperations(subjectId);
  } catch (error) {
    if (error instanceof Error && error.message === 'FEATURE_ACCESS_ACCOUNT_CHANGED') {
      throw error;
    }
    const wrapped = new Error('无法恢复待同步的回收站操作，请稍后重试。') as Error & {
      cause?: unknown;
    };
    wrapped.cause = error;
    throw wrapped;
  }
}
